// Production server entry point
import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { createServer as createViteServer } from "vite";
import path from "path";
import ccxt from "ccxt";
import admin from "firebase-admin";
import { getFirestore } from "firebase-admin/firestore";
import firebaseConfig from "./firebase-applet-config.json";

// Initialize Firebase Admin
const adminApp = admin.initializeApp({
  projectId: firebaseConfig.projectId,
});
const db = getFirestore(adminApp, firebaseConfig.firestoreDatabaseId);

async function startServer() {
  const app = express();
  const httpServer = createServer(app);
  const io = new Server(httpServer, {
    cors: {
      origin: "*",
    },
  });

  const PORT = 3000;

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
      addLog(`Error recording trade: ${error.message}`, "error");
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
        io.emit("ticker_update", currentPrices);
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

    socket.on("toggle_bot", (status: boolean) => {
      isBotRunning = status;
      addLog(`Simulation ${isBotRunning ? "started" : "stopped"}`, isBotRunning ? "success" : "warning");
      io.emit("status", { isBotRunning, hasApiKeys });
      if (isBotRunning) runArbitrageLoop();
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
  });
}

startServer();
