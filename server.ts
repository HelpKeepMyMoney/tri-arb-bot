// Production server entry point
import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { createServer as createViteServer } from "vite";
import path from "path";
import { existsSync } from "fs";
import { fileURLToPath } from "node:url";
import ccxt from "ccxt";
import admin from "firebase-admin";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import firebaseConfig from "./firebase-applet-config.json";

process.on("unhandledRejection", (reason) => {
  console.error("[process] unhandledRejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[process] uncaughtException:", err);
});

/** Dist lives next to server.ts (not process.cwd()), so hosting still works if cwd differs. */
const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));

type ParsedServiceAccountKey =
  | { kind: "none" }
  | { kind: "error"; message: string }
  | { kind: "ok"; account: admin.ServiceAccount };

function parseServiceAccountKeyRaw(raw: string | undefined): ParsedServiceAccountKey {
  if (!raw?.trim()) return { kind: "none" };
  let s = raw.trim();
  if (s.startsWith("%7B")) {
    try {
      s = decodeURIComponent(s);
    } catch {
      /* ignore */
    }
  }
  let account: admin.ServiceAccount;
  try {
    account = JSON.parse(s) as admin.ServiceAccount;
  } catch {
    try {
      account = JSON.parse(Buffer.from(s, "base64").toString("utf8")) as admin.ServiceAccount;
    } catch {
      return {
        kind: "error",
        message:
          "is set but is not valid JSON (or base64-wrapped JSON). Re-paste the full key as one line.",
      };
    }
  }
  if (!account.private_key || !account.client_email) {
    return { kind: "error", message: "JSON must include private_key and client_email" };
  }
  return { kind: "ok", account };
}

const parsedServiceAccountKey = parseServiceAccountKeyRaw(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);

function buildAdminOptions(): admin.AppOptions {
  const projectId = firebaseConfig.projectId;
  if (parsedServiceAccountKey.kind === "error") {
    console.error(
      `[Firestore] FIREBASE_SERVICE_ACCOUNT_KEY ${parsedServiceAccountKey.message} — starting without that key (Firestore may fail).`
    );
    return { projectId };
  }
  if (parsedServiceAccountKey.kind === "none") {
    return { projectId };
  }
  const { account } = parsedServiceAccountKey;
  if (account.project_id && account.project_id !== projectId) {
    console.error(
      `[Firestore] Key project_id "${account.project_id}" does not match firebase-applet-config projectId "${projectId}". ` +
        "Fix the key or config — mismatched projects cause PERMISSION_DENIED."
    );
  }
  try {
    console.log(`[Firestore] Loaded Admin credential: ${account.client_email}`);
    return {
      credential: admin.credential.cert(account),
      projectId,
    };
  } catch (e: unknown) {
    const m = e instanceof Error ? e.message : String(e);
    console.error("[Firestore] Could not build credential from key JSON:", m);
    return { projectId };
  }
}

// Bad secrets must not prevent the HTTP server from starting (otherwise Railway returns 502).
let adminApp: admin.app.App;
let db: Firestore;
let firestoreUsesServiceAccountJson = parsedServiceAccountKey.kind === "ok";
try {
  adminApp = admin.initializeApp(buildAdminOptions());
  db = getFirestore(adminApp, firebaseConfig.firestoreDatabaseId);
} catch (err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error("[Firebase] Admin SDK init failed — recovering with projectId only:", msg);
  firestoreUsesServiceAccountJson = false;
  try {
    adminApp = admin.apps.length > 0 ? admin.app() : admin.initializeApp({ projectId: firebaseConfig.projectId });
    db = getFirestore(adminApp, firebaseConfig.firestoreDatabaseId);
  } catch (err2: unknown) {
    const m2 = err2 instanceof Error ? err2.message : String(err2);
    console.error("[Firebase] Fatal: could not initialize after recovery attempt:", m2);
    process.exit(1);
  }
}

if (parsedServiceAccountKey.kind === "none") {
  console.warn(
    "[Firestore] FIREBASE_SERVICE_ACCOUNT_KEY is not set. On Railway and most non-GCP hosts, " +
      "Firestore writes will fail with PERMISSION_DENIED. Add the JSON key from Firebase Console → " +
      "Project settings → Service accounts → Generate new private key (set as a single-line variable)."
  );
}

/** Same DB + `.add()` shape as real hits; separate collection so the UI history stays clean. */
const STARTUP_FIRESTORE_TEST_COLLECTION = "startup_firestore_tests";

async function runStartupFirestoreTest(firestore: Firestore) {
  const dbId = firebaseConfig.firestoreDatabaseId;
  const payload = {
    isStartupTest: true,
    profit: 0,
    profitPercent: 0,
    timestamp: new Date().toISOString(),
    details: {
      note: "Server startup Firestore write check (same path as arbitrage_hits.add)",
      nodeEnv: process.env.NODE_ENV ?? "undefined",
    },
  };

  try {
    await firestore.collection("arbitrage_hits").limit(1).get();
    console.log(`[Firestore] Startup read OK (database "${dbId}")`);
  } catch (e: any) {
    console.error(`[Firestore] Startup read failed [${e?.code}]:`, e?.message);
  }

  try {
    const ref = await firestore.collection(STARTUP_FIRESTORE_TEST_COLLECTION).add(payload);
    console.log(
      `[Firestore] Startup test record written OK — collection "${STARTUP_FIRESTORE_TEST_COLLECTION}" doc "${ref.id}" (database "${dbId}")`
    );
  } catch (e: any) {
    console.error(`[Firestore] Startup test write failed [${e?.code}]:`, e?.message);
    if (!firestoreUsesServiceAccountJson) {
      console.error(
        '[Firestore] No valid service account JSON was loaded (see warnings above). ' +
          "Railway must set FIREBASE_SERVICE_ACCOUNT_KEY for this database."
      );
    } else {
      console.error(
        "[Firestore] If this is PERMISSION_DENIED with a key set: confirm Railway attached the variable to this service, " +
          "regenerate the key, or add role Cloud Datastore User to this service account for project " +
          firebaseConfig.projectId +
          "."
      );
    }
  }
}

async function startServer() {
  const app = express();
  app.set("trust proxy", 1);
  // Always register first so proxies never hit a mis-ordered catch-all.
  app.get("/health", (_req, res) => {
    res.status(200).type("text/plain").send("ok");
  });

  const httpServer = createServer(app);
  const io = new Server(httpServer, {
    cors: {
      origin: "*",
    },
  });

  const rawPort = process.env.PORT;
  const PORT =
    rawPort !== undefined && rawPort !== "" && /^\d+$/.test(rawPort)
      ? parseInt(rawPort, 10)
      : 3000;

  // Initialize Exchange (Phemex)
  const exchange = new ccxt.phemex({
    apiKey: process.env.EXCHANGE_API_KEY,
    secret: process.env.EXCHANGE_SECRET,
    enableRateLimit: true,
  });

  let isBotRunning = false;
  let logs: any[] = [];
  let successfulTrades: any[] = [];
  let lastEmittedPrices: Record<string, number> = {};

  const addLog = (message: string, type: "info" | "success" | "warning" | "error" = "info") => {
    const log = { id: Date.now(), timestamp: new Date().toISOString(), message, type };
    logs.unshift(log);
    // Optimization: Keep logs small (max 20) to save memory
    if (logs.length > 20) logs.pop();
    io.emit("log", log);
  };

  const hasApiKeys = Boolean(process.env.EXCHANGE_API_KEY && process.env.EXCHANGE_SECRET);
  if (hasApiKeys) {
    console.log("Phemex API keys detected. Simulation Mode active (Live Trading Ready).");
    addLog("System: Simulation Mode active (API Connected)", "info");
  } else {
    console.log("Phemex API keys not detected. Simulation Mode active (Monitoring only).");
    addLog("System: Simulation Mode active (Monitoring Only)", "info");
  }

  const executeTrade = async (opportunity: any) => {
    if (!hasApiKeys) {
      addLog(`Simulation: Arbitrage opportunity detected (${opportunity.profitPercent.toFixed(4)}%)`, "info");
      return;
    }

    try {
      addLog(`Simulation: Executing virtual triangle trade (${opportunity.profitPercent.toFixed(4)}%)`, "info");
      // In a real scenario, we would execute here. 
      // For now, we keep it as a simulation even with keys to be safe.
      addLog("Simulation: Virtual triangle trade completed successfully!", "success");
    } catch (error: any) {
      addLog(`Simulation: Virtual trade failed: ${error.message}`, "error");
    }
  };

  const addTrade = async (trade: any) => {
    try {
      // Record to Firestore
      await db.collection("arbitrage_hits").add({
        ...trade,
        timestamp: trade.timestamp || new Date().toISOString(),
      });
      
      successfulTrades.unshift({ id: Date.now(), ...trade });
      // Optimization: Keep history small (max 30)
      if (successfulTrades.length > 30) successfulTrades.pop();
      io.emit("trade_recorded", trade);
      
      if (hasApiKeys) {
        await executeTrade(trade);
      }
    } catch (error: any) {
      const msg = String(error?.message || error);
      const hint =
        /PERMISSION_DENIED|insufficient permissions/i.test(msg) && !firestoreUsesServiceAccountJson
          ? " Configure FIREBASE_SERVICE_ACCOUNT_KEY on the host (service account needs Cloud Datastore User or Editor on this project)."
          : /PERMISSION_DENIED|insufficient permissions/i.test(msg)
            ? " Check the service account has Firestore access for database \"" +
              firebaseConfig.firestoreDatabaseId +
              "\"."
            : "";
      addLog(`Error recording trade: ${msg}${hint}`, "error");
    }
  };

  // Arbitrage Logic
  const runArbitrageLoop = async () => {
    if (!isBotRunning) return;

    try {
      // Triangle: BTC -> ETH -> USDT -> BTC
      // Pairs: ETH/BTC, ETH/USDT, BTC/USDT
      const symbols = ["ETH/BTC", "ETH/USDT", "BTC/USDT"];
      const tickers = await exchange.fetchTickers(symbols);

      const eth_btc = tickers["ETH/BTC"];
      const eth_usdt = tickers["ETH/USDT"];
      const btc_usdt = tickers["BTC/USDT"];

      if (!eth_btc || !eth_usdt || !btc_usdt) {
        return;
      }

      // Optimization: Throttled UI update (only emit if price changed by > 0.01%)
      const currentPrices = {
        "ETH/BTC": eth_btc.last || 0,
        "ETH/USDT": eth_usdt.last || 0,
        "BTC/USDT": btc_usdt.last || 0
      };

      let shouldUpdateUI = false;
      for (const [symbol, price] of Object.entries(currentPrices)) {
        const lastPrice = lastEmittedPrices[symbol] || 0;
        if (Math.abs(price - lastPrice) / (lastPrice || 1) > 0.0001) {
          shouldUpdateUI = true;
          lastEmittedPrices[symbol] = price;
        }
      }

      if (shouldUpdateUI) {
        // We skip the simple emission here because the full one below is better
      }

      // 1. Start with 1 BTC
      const initialAmount = 1;

      // 2. Buy ETH with BTC (BTC -> ETH)
      // Amount of ETH = initialAmount / ask
      const ethAmount = initialAmount / eth_btc.ask!;

      // 3. Sell ETH for USDT (ETH -> USDT)
      // Amount of USDT = ethAmount * bid
      const usdtAmount = ethAmount * eth_usdt.bid!;

      // 4. Sell USDT for BTC (USDT -> BTC)
      // Equivalent to buying BTC with USDT (BTC/USDT)
      // Final BTC = usdtAmount / ask
      const finalAmount = usdtAmount / btc_usdt.ask!;

      const profit = finalAmount - initialAmount;
      const profitPercent = (profit / initialAmount) * 100;

      const opportunity = {
        profit,
        profitPercent,
        timestamp: new Date().toISOString(),
        details: {
          initial: initialAmount,
          eth: ethAmount,
          usdt: usdtAmount,
          final: finalAmount,
          prices: {
            "ETH/BTC": eth_btc.ask,
            "ETH/USDT": eth_usdt.bid,
            "BTC/USDT": btc_usdt.ask
          }
        }
      };

      io.emit("ticker_update", {
        pairs: {
          "ETH/BTC": { bid: eth_btc.bid, ask: eth_btc.ask },
          "ETH/USDT": { bid: eth_usdt.bid, ask: eth_usdt.ask },
          "BTC/USDT": { bid: btc_usdt.bid, ask: btc_usdt.ask },
        },
        opportunity
      });

      if (profitPercent > 0.05) { // Lowered threshold for recording to 0.05%
        addLog(`Arbitrage opportunity detected! Profit: ${profitPercent.toFixed(4)}%`, "success");
        await addTrade(opportunity);
      }

    } catch (error: any) {
      addLog(`Error in arbitrage loop: ${error.message}`, "error");
    }

    if (isBotRunning) {
      setTimeout(runArbitrageLoop, 1000); // Check every second
    }
  };

  io.on("connection", (socket) => {
    console.log("Client connected");
    socket.emit("status", { isBotRunning, hasApiKeys });
    socket.emit("logs", logs);
    socket.emit("trades_history", successfulTrades);

    socket.on("toggle_bot", async (data: { status: boolean, token: string }) => {
      console.log("Received toggle_bot request", { status: data.status });
      try {
        const decodedToken = await admin.auth().verifyIdToken(data.token);
        console.log("Token verified for", decodedToken.email);
        
        // Primary admin check via email (bypasses Firestore credential requirement)
        let isAdmin = decodedToken.email === 'helpkeepmymoney@gmail.com';
        
        // If not the primary admin, try checking Firestore (may fail if credentials aren't set on Railway)
        if (!isAdmin) {
          try {
            const userDoc = await db.collection("users").doc(decodedToken.uid).get();
            isAdmin = userDoc.exists && userDoc.data()?.role === 'admin';
          } catch (dbError) {
            console.warn("Could not verify admin role via Firestore (missing credentials). Falling back to email check.");
          }
        }

        console.log("User role check result:", { email: decodedToken.email, isAdmin });

        if (isAdmin) {
          const wasRunning = isBotRunning;
          isBotRunning = data.status;
          addLog(`Simulation ${isBotRunning ? "started" : "stopped"} by ${decodedToken.email}`, isBotRunning ? "success" : "warning");
          io.emit("status", { isBotRunning, hasApiKeys });
          
          if (isBotRunning && !wasRunning) {
            runArbitrageLoop();
          }
        } else {
          socket.emit("error", "Unauthorized: Only administrators can control the bot.");
          addLog(`Unauthorized toggle attempt by ${decodedToken.email}`, "error");
        }
      } catch (error: any) {
        console.error("Auth error in toggle_bot:", error.code, error.message);
        socket.emit("error", `Authentication failed: ${error.message}`);
      }
    });
  });

  // Serve `dist` when present unless NODE_ENV=development. Unset NODE_ENV still serves static
  // (Railway) so we never boot Vite in the container by mistake.
  const distPath = path.join(SERVER_DIR, "dist");
  const distIndex = path.join(distPath, "index.html");
  const distExists = existsSync(distIndex);
  const useStaticDist = distExists && process.env.NODE_ENV !== "development";

  console.log("[Server] boot", {
    NODE_ENV: process.env.NODE_ENV ?? "(unset)",
    PORT: process.env.PORT ?? "(unset)",
    cwd: process.cwd(),
    serverDir: SERVER_DIR,
    distPath,
    distExists,
    useStaticDist,
  });

  if (!useStaticDist) {
    console.log("[Server] Vite dev middleware (no static dist for this mode)");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    console.log(`[Server] Serving static app from ${distPath}`);
    app.use(
      express.static(distPath, {
        fallthrough: true,
        index: ["index.html"],
        etag: true,
      })
    );
    // SPA fallback (avoid Express `*` path quirks); Engine.IO runs before this stack for /socket.io/*
    app.use((req, res, next) => {
      if (req.method !== "GET" && req.method !== "HEAD") {
        return next();
      }
      res.sendFile(distIndex, (err) => {
        if (err) next(err);
      });
    });
  }

  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error("[Server] Route error:", err instanceof Error ? err.message : err);
    if (!res.headersSent) {
      res.status(500).type("text/plain").send("Internal Server Error");
    }
  });

  httpServer.keepAliveTimeout = 75_000;
  httpServer.headersTimeout = 76_000;

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`, httpServer.address());
    void runStartupFirestoreTest(db);

    const shutdown = (signal: string) => {
      console.log(`[Server] ${signal} received, closing HTTP + Socket.IO...`);
      io.close(() => {
        httpServer.close(() => {
          console.log("[Server] Graceful shutdown complete");
          process.exit(0);
        });
      });
      setTimeout(() => {
        console.error("[Server] Shutdown timed out");
        process.exit(1);
      }, 10_000).unref();
    };
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
  });
}

startServer().catch((err) => {
  console.error("[Server] Fatal startup error:", err);
  process.exit(1);
});
