import express from "express";
import dotenv from "dotenv";
import { GoogleGenAI, GenerateVideosOperation } from "@google/genai";

dotenv.config();

const app = express();
app.use(express.json({ limit: "50mb" }));
const PORT = process.env.PORT || 3000;

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.warn("WARNING: GEMINI_API_KEY environment variable is missing.");
}

const ai = new GoogleGenAI({
  apiKey: apiKey || "MOCK_KEY",
  httpOptions: { headers: { "User-Agent": "aistudio-build" } },
});

const MAX_CACHE_ENTRIES = 30;
const videoCache = new Map<string, Buffer>();

function persistVideo(operationName: string, buffer: Buffer): void {
  videoCache.set(operationName, buffer);
  while (videoCache.size > MAX_CACHE_ENTRIES) {
    const oldestKey = videoCache.keys().next().value;
    if (oldestKey === undefined) break;
    videoCache.delete(oldestKey);
  }
}

function loadVideo(operationName: string): Buffer | null {
  return videoCache.get(operationName) || null;
}

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.post("/api/generate-video", async (req, res) => {
  try {
    const { prompt, aspectRatio, resolution } = req.body;
    if (!prompt) return res.status(400).json({ error: "Prompt is required" });

    const isPortrait = aspectRatio?.includes("9:16");
    const ar = isPortrait ? "9:16" : "16:9";
    const wants720p = resolution?.includes("720p");
    const resValue = (wants720p || isPortrait) ? "720p" : "1080p";

    if (!apiKey || apiKey === "MOCK_KEY") {
      return res.status(503).json({ error: "GEMINI_API_KEY is missing." });
    }

    const operation = await ai.models.generateVideos({
      model: "veo-3.1-fast-generate-preview",
      prompt,
      config: { numberOfVideos: 1, resolution: resValue, aspectRatio: ar },
    });

    return res.json({ operationName: operation.name });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "Failed to start video generation" });
  }
});

app.post("/api/video-status", async (req, res) => {
  try {
    const { operationName } = req.body;
    if (!operationName) return res.status(400).json({ error: "operationName is required" });

    const op = new GenerateVideosOperation();
    op.name = operationName;
    const updated = await ai.operations.getVideosOperation({ operation: op });

    if (updated.done && !updated.error) {
      const existing = loadVideo(operationName);
      if (!existing) {
        const uri = updated.response?.generatedVideos?.[0]?.video?.uri;
        if (uri) {
          const videoRes = await fetch(uri, { headers: { "x-goog-api-key": apiKey || "" } });
          if (videoRes.ok) {
            persistVideo(operationName, Buffer.from(await videoRes.arrayBuffer()));
          }
        }
      }
    }

    return res.json({ done: updated.done, error: updated.error ? { message: updated.error.message } : null });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

app.get("/api/video", async (req, res) => {
  try {
    const operationName = req.query.operationName as string;
    const download = req.query.download === "true";
    if (!operationName) return res.status(400).send("operationName required");

    let buffer = loadVideo(operationName);

    if (!buffer) {
      const op = new GenerateVideosOperation();
      op.name = operationName;
      const updated = await ai.operations.getVideosOperation({ operation: op });
      if (!updated.done) return res.status(202).send("Still generating");
      const uri = updated.response?.generatedVideos?.[0]?.video?.uri;
      if (!uri) return res.status(404).send("Video URI not found");
      const videoRes = await fetch(uri, { headers: { "x-goog-api-key": apiKey || "" } });
      buffer = Buffer.from(await videoRes.arrayBuffer());
      persistVideo(operationName, buffer);
    }

    const range = req.headers.range;
    if (range) {
      const [startStr, endStr] = range.replace(/bytes=/, "").split("-");
      const start = parseInt(startStr, 10);
      const end = endStr ? parseInt(endStr, 10) : buffer.length - 1;
      res.writeHead(206, {
        "Content-Range": `bytes ${start}-${end}/${buffer.length}`,
        "Accept-Ranges": "bytes",
        "Content-Length": end - start + 1,
        "Content-Type": "video/mp4",
        "Access-Control-Allow-Origin": "*",
        ...(download ? { "Content-Disposition": 'attachment; filename="video.mp4"' } : {}),
      });
      return res.end(buffer.slice(start, end + 1));
    }

    res.writeHead(200, {
      "Content-Length": buffer.length,
      "Content-Type": "video/mp4",
      "Accept-Ranges": "bytes",
      "Access-Control-Allow-Origin": "*",
      ...(download ? { "Content-Disposition": 'attachment; filename="video.mp4"' } : {}),
    });
    return res.end(buffer);
  } catch (error: any) {
    res.status(500).send(error.message);
  }
});

app.post("/api/enhance-prompt", async (req, res) => {
  try {
    const { prompt, style, music } = req.body;
    if (!prompt) return res.status(400).json({ error: "Prompt is required" });

    const response = await ai.models.generateContent({
      model: "gemini-2.5-pro-preview-06-05",
      contents: `You are an expert Hollywood film director. Expand this prompt for Veo 3 AI video generation.

User prompt: "${prompt}"
${style ? `Style: ${style}` : ""}
${music ? `Music: ${music}` : ""}

Respond ONLY with valid JSON:
{
  "enhancedPrompt": "expanded cinematic prompt",
  "directorNotes": "camera, lighting, pacing notes",
  "suggestedAudio": "sound design description"
}`,
      config: { responseMimeType: "application/json" },
    });

    return res.json(JSON.parse(response.text || "{}"));
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

app.get("/", (req, res) => res.send("VidAI Backend is running!"));

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
