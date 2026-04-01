// Production server entry point
import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { createServer as createViteServer } from "vite";
import path from "path";
import ccxt from "ccxt";
import admin from "firebase-admin";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import firebaseConfig from "./firebase-applet-config.json";

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
    throw new Error(`FIREBASE_SERVICE_ACCOUNT_KEY ${parsedServiceAccountKey.message}`);
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
  console.log(`[Firestore] Loaded Admin credential: ${account.client_email}`);
  return {
    credential: admin.credential.cert(account),
    projectId,
  };
}

// Initialize Firebase Admin
const adminApp = admin.initializeApp(buildAdminOptions());
const db = getFirestore(adminApp, firebaseConfig.firestoreDatabaseId);

const firestoreUsesServiceAccountJson = parsedServiceAccountKey.kind === "ok";
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
  const httpServer = createServer(app);
  const io = new Server(httpServer, {
    cors: {
      origin: "*",
    },
  });

  const PORT = Number(process.env.PORT) || 3000;

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

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
    void runStartupFirestoreTest(db);
  });
}

startServer();
