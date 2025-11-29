// server.js
import express from "express";
import dotenv from "dotenv";
import cors from "cors";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());
app.use(express.static("public")); // where index.html, search.html live

// ============ SIMPLE PER-IP DAILY LIMITS ============
let usageByIp = {};
let lastReset = Date.now();

const MAX_AI_PER_DAY = 20;     // per IP per day
const MAX_WEB_PER_DAY = 100;   // per IP per day (you can change)

function resetIfNeeded() {
  const ONE_DAY = 24 * 60 * 60 * 1000;
  if (Date.now() - lastReset > ONE_DAY) {
    usageByIp = {};
    lastReset = Date.now();
  }
}

function getIp(req) {
  return (
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.ip ||
    "unknown"
  );
}

function ensureIpSlot(ip) {
  if (!usageByIp[ip]) {
    usageByIp[ip] = { ai: 0, web: 0 };
  }
  return usageByIp[ip];
}

function isNetworkError(err) {
  return (
    err &&
    (err.code === "ENOTFOUND" ||
      err.code === "ECONNREFUSED" ||
      err.code === "EAI_AGAIN" ||
      err.code === "ETIMEDOUT")
  );
}

// ================== MAIN SEARCH ROUTE ==================
app.post("/api/search", async (req, res) => {
  resetIfNeeded();

  const { query, mode } = req.body || {};
  if (!query || typeof query !== "string") {
    return res.status(400).json({ answer: "Missing or invalid 'query'." });
  }

  const ip = getIp(req);
  const usage = ensureIpSlot(ip);

  try {
    // ===================== AI MODE (GROQ) =====================
    if (mode === "ai") {
      if (usage.ai >= MAX_AI_PER_DAY) {
        return res.json({
          answer:
            "You have reached the free AI limit for today. Please try again tomorrow or use Web Summary mode.",
        });
      }

      usage.ai += 1;

      const groqKey = process.env.GROQ_API_KEY;
      if (!groqKey) {
        return res.json({
          answer: `Mock AI response for "${query}" (GROQ_API_KEY not set on server).`,
        });
      }

      try {
        const aiRes = await fetch(
          "https://api.groq.com/openai/v1/chat/completions",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${groqKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: "llama-3.1-8b-instant", // or another Groq model
              messages: [
                {
                  role: "system",
                  content:
                    "You are SearchNet, a helpful, clear and concise AI assistant. Explain things in simple language, especially for a class 9–10 student. Avoid unsafe or illegal instructions.",
                },
                { role: "user", content: query },
              ],
              temperature: 0.6,
              max_tokens: 512,
            }),
          }
        );

        const aiData = await aiRes.json();
        const answer =
          aiData?.choices?.[0]?.message?.content ||
          "AI error: No response from Groq model.";

        return res.json({ answer });
      } catch (err) {
        console.error("GROQ AI error:", err);

        if (isNetworkError(err)) {
          return res.json({
            answer: `Mock AI response for "${query}" (network cannot reach Groq from this server).`,
          });
        }

        return res.json({
          answer: "AI error: Unexpected server error while calling Groq.",
        });
      }
    }

    // ===================== WEB MODE (TAVILY) =====================
    if (mode === "web") {
      if (usage.web >= MAX_WEB_PER_DAY) {
        return res.json({
          answer:
            "You have reached the free Web Summary limit for today. Please try again tomorrow.",
          results: [],
        });
      }

      usage.web += 1;

      const tavKey = process.env.TAVILY_API_KEY;
      if (!tavKey) {
        return res.json({
          answer: `Mock web summary for "${query}" (TAVILY_API_KEY not set on server).`,
          results: [],
        });
      }

      try {
        const webRes = await fetch("https://api.tavily.com/search", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${tavKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            query,
            search_depth: "advanced",
            include_answer: true,
            max_results: 8,
          }),
        });

        const webData = await webRes.json();
        return res.json(webData);
      } catch (err) {
        console.error("Tavily web error:", err);

        if (isNetworkError(err)) {
          return res.json({
            answer: `Mock web summary for "${query}" (network cannot reach Tavily from this server).`,
            results: [],
          });
        }

        return res.json({
          answer: "Web summary error: Unexpected server error.",
          results: [],
        });
      }
    }

    // ===================== INVALID MODE =====================
    return res.json({
      answer: "Invalid mode. Use 'ai' or 'web'.",
    });
  } catch (err) {
    console.error("GLOBAL SERVER ERROR:", err);
    return res.status(500).json({
      answer: "Server crashed internally.",
    });
  }
});

// ================== START SERVER ==================
app.listen(PORT, () => {
  console.log(`🚀 Backend running at http://localhost:${PORT}`);
});
