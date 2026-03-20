import * as React from 'react';
import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { io, Socket } from 'socket.io-client';
import { 
  TrendingUp, 
  Play, 
  Square, 
  Activity, 
  History, 
  Settings, 
  ArrowRightLeft,
  AlertCircle,
  CheckCircle2,
  Info,
  LogIn,
  LogOut,
  User,
  Zap,
  Calculator,
  X,
  ChevronRight
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  LineChart, 
  Line, 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip, 
  ResponsiveContainer,
  AreaChart,
  Area
} from 'recharts';
import { 
  auth, 
  db, 
  googleProvider, 
  signInWithPopup, 
  onAuthStateChanged, 
  collection, 
  onSnapshot, 
  query, 
  orderBy, 
  limit 
} from './firebase';

interface Log {
  id: number;
  timestamp: string;
  message: string;
  type: 'info' | 'success' | 'warning' | 'error';
}

interface TickerData {
  bid: number;
  ask: number;
}

interface Opportunity {
  id?: string;
  profit: number;
  profitPercent: number;
  timestamp: string;
  details?: {
    initial: number;
    eth: number;
    usdt: number;
    final: number;
    prices: Record<string, number>;
  };
}

interface TickerUpdate {
  pairs: Record<string, TickerData>;
  opportunity: Opportunity;
}

interface ErrorBoundaryProps {
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: any;
}

class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { hasError: false, error: null };

  constructor(props: ErrorBoundaryProps) {
    super(props);
  }

  static getDerivedStateFromError(error: any) {
    return { hasError: true, error };
  }

  componentDidCatch(error: any, errorInfo: any) {
    console.error("ErrorBoundary caught an error", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      const isStorageError = this.state.error?.message?.includes('FILE_ERROR_NO_SPACE') || 
                            String(this.state.error).includes('FILE_ERROR_NO_SPACE');

      return (
        <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center p-6 text-center">
          <div className="max-w-md space-y-4">
            <AlertCircle className="w-12 h-12 text-red-500 mx-auto" />
            <h1 className="text-xl font-bold text-white">
              {isStorageError ? 'Storage Space Required' : 'Something went wrong'}
            </h1>
            <p className="text-zinc-400 text-sm">
              {isStorageError 
                ? 'Your browser storage is full. Please clear some space or close other tabs to continue using the application.'
                : 'The application encountered an error. This might be due to a lack of browser storage space or a temporary connection issue.'}
            </p>
            <pre className="p-4 bg-black rounded-lg text-xs text-red-400 overflow-auto max-h-40 text-left">
              {this.state.error?.message || String(this.state.error)}
            </pre>
            <div className="flex flex-col gap-2">
              <button 
                onClick={() => window.location.reload()}
                className="px-6 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg transition-colors font-medium"
              >
                Reload Application
              </button>
              {isStorageError && (
                <p className="text-[10px] text-zinc-500">
                  Tip: Try clearing your browser cache or deleting old data from your disk.
                </p>
              )}
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

function App() {
  return (
    <ErrorBoundary>
      <Dashboard />
    </ErrorBoundary>
  );
}

// Memoized sub-components for performance
const TickerCard = React.memo(({ pair, data }: { pair: string; data: TickerData | undefined }) => {
  if (!data) return null;
  return (
    <div className="bg-zinc-900/40 border border-white/5 rounded-2xl p-4 space-y-2">
      <div className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider">{pair}</div>
      <div className="flex justify-between items-end">
        <div className="text-lg font-mono font-bold text-white">{data.bid.toFixed(pair.includes('BTC') ? 6 : 2)}</div>
        <div className="text-[10px] font-mono text-zinc-500">BID</div>
      </div>
      <div className="flex justify-between items-end">
        <div className="text-lg font-mono font-bold text-white">{data.ask.toFixed(pair.includes('BTC') ? 6 : 2)}</div>
        <div className="text-[10px] font-mono text-zinc-500">ASK</div>
      </div>
    </div>
  );
});

const LogItem = React.memo(({ log }: { log: Log }) => {
  const icon = {
    info: <Info className="w-3 h-3 text-blue-400" />,
    success: <CheckCircle2 className="w-3 h-3 text-emerald-400" />,
    warning: <AlertCircle className="w-3 h-3 text-amber-400" />,
    error: <AlertCircle className="w-3 h-3 text-red-400" />
  }[log.type];

  return (
    <div className="flex gap-3 text-[11px] group">
      <span className="text-zinc-600 font-mono shrink-0">
        {log.timestamp ? new Date(log.timestamp).toLocaleTimeString([], { hour12: false }) : '--:--:--'}
      </span>
      <div className="mt-0.5 shrink-0">{icon}</div>
      <span className={`break-words ${log.type === 'error' ? 'text-red-400' : log.type === 'success' ? 'text-emerald-400' : 'text-zinc-300'}`}>
        {log.message}
      </span>
    </div>
  );
});

const TradeRow = React.memo(({ trade, onSimulate }: { trade: Opportunity; onSimulate: (t: Opportunity) => void }) => (
  <motion.tr 
    initial={{ opacity: 0, y: 10 }}
    animate={{ opacity: 1, y: 0 }}
    className="group hover:bg-white/[0.02] transition-colors"
  >
    <td className="py-4 text-xs font-mono text-zinc-400">
      {trade.timestamp ? new Date(trade.timestamp).toLocaleTimeString() : 'N/A'}
    </td>
    <td className="py-4 text-xs text-center">
      <span className="px-2 py-0.5 rounded bg-zinc-800 text-zinc-400 border border-white/5">BTC → ETH → USDT → BTC</span>
    </td>
    <td className={`py-4 text-xs font-mono font-bold text-right ${trade.profitPercent > 0 ? 'text-emerald-400' : 'text-red-400'}`}>
      {trade.profitPercent.toFixed(4)}%
    </td>
    <td className="py-4 text-xs font-mono text-right text-zinc-300">
      {trade.profit.toFixed(8)}
    </td>
    <td className="py-4 text-right">
      <button 
        onClick={() => onSimulate(trade)}
        className="px-3 py-1 text-[10px] font-bold uppercase bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded border border-white/5 transition-colors"
      >
        Simulate
      </button>
    </td>
  </motion.tr>
));

// Dashboard component starts here
function Dashboard() {
  const [user, setUser] = useState<any>(null);
  const [isBotRunning, setIsBotRunning] = useState(false);
  const [hasApiKeys, setHasApiKeys] = useState(false);
  const [logs, setLogs] = useState<Log[]>([]);
  const [tradesHistory, setTradesHistory] = useState<Opportunity[]>([]);
  const [tickerData, setTickerData] = useState<Record<string, TickerData>>({});
  const [opportunity, setOpportunity] = useState<Opportunity | null>(null);
  const [history, setHistory] = useState<any[]>([]);
  const [selectedSimulationTrade, setSelectedSimulationTrade] = useState<Opportunity | null>(null);
  const [simulationAmount, setSimulationAmount] = useState<number>(0.1); // Default 0.1 BTC
  const [storageError, setStorageError] = useState<string | null>(null);
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    // Check for storage availability
    const checkStorage = async () => {
      try {
        if ('storage' in navigator && 'estimate' in navigator.storage) {
          const { usage, quota } = await navigator.storage.estimate();
          if (usage && quota && usage > quota * 0.9) {
            setStorageError('Browser storage is almost full. This may cause issues with the application.');
          }
        }
      } catch (e) {
        console.warn('Storage estimate failed', e);
      }
    };
    checkStorage();
  }, []);

  useEffect(() => {
    const unsubscribeAuth = onAuthStateChanged(auth, (user) => {
      setUser(user);
    });

    const socket = io();
    socketRef.current = socket;

    socket.on('status', (data: { isBotRunning: boolean, hasApiKeys: boolean }) => {
      setIsBotRunning(data.isBotRunning);
      setHasApiKeys(data.hasApiKeys);
    });

    socket.on('logs', (data: Log[]) => {
      setLogs(data);
    });

    socket.on('log', (log: Log) => {
      setLogs(prev => [log, ...prev].slice(0, 50));
    });

    socket.on('ticker_update', (data: TickerUpdate) => {
      setTickerData(data.pairs);
      if (data.opportunity) {
        setOpportunity(data.opportunity);
        setHistory(prev => [...prev, {
          time: data.opportunity.timestamp ? new Date(data.opportunity.timestamp).toLocaleTimeString() : new Date().toLocaleTimeString(),
          profit: data.opportunity.profitPercent
        }].slice(-30));
      }
    });

    return () => {
      unsubscribeAuth();
      socket.disconnect();
    };
  }, []);

  // Listen to Firestore for hits
  useEffect(() => {
    if (!user) {
      setTradesHistory([]);
      return;
    }

    const q = query(collection(db, 'arbitrage_hits'), orderBy('timestamp', 'desc'), limit(100));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const hits = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      })) as Opportunity[];
      setTradesHistory(hits);
    }, (error) => {
      console.error("Firestore Error:", error);
    });

    return () => unsubscribe();
  }, [user]);

  const toggleBot = useCallback(() => {
    socketRef.current?.emit('toggle_bot', !isBotRunning);
  }, [isBotRunning]);

  const handleLogin = useCallback(async () => {
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (error) {
      console.error("Login failed:", error);
    }
  }, []);

  const handleLogout = useCallback(() => auth.signOut(), []);

  const closeSimulationModal = useCallback(() => setSelectedSimulationTrade(null), []);

  const memoizedHistory = useMemo(() => history, [history]);
  const memoizedTradesHistory = useMemo(() => tradesHistory, [tradesHistory]);
  const memoizedLogs = useMemo(() => logs, [logs]);
  const memoizedTickerData = useMemo(() => tickerData, [tickerData]);

  if (!user) {
    return (
      <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center p-6">
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="max-w-md w-full bg-zinc-900/50 border border-white/5 rounded-3xl p-8 text-center space-y-8"
        >
          <div className="w-16 h-16 bg-emerald-500 rounded-2xl flex items-center justify-center mx-auto shadow-[0_0_30px_rgba(16,185,129,0.2)]">
            <TrendingUp className="w-8 h-8 text-black" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-white mb-2">TriArb Pro</h1>
            <p className="text-zinc-400 text-sm">Secure Triangle Arbitrage Monitoring & Execution. Please sign in to access the dashboard.</p>
          </div>
          <button 
            onClick={handleLogin}
            className="w-full flex items-center justify-center gap-3 py-4 bg-white text-black rounded-2xl font-bold hover:bg-zinc-200 transition-all active:scale-95"
          >
            <LogIn className="w-5 h-5" />
            Sign in with Google
          </button>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-zinc-100 font-sans selection:bg-emerald-500/30">
      {/* Header */}
      <header className="border-b border-white/5 bg-black/20 backdrop-blur-md sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-emerald-500 rounded-lg flex items-center justify-center shadow-[0_0_15px_rgba(16,185,129,0.4)]">
              <TrendingUp className="w-5 h-5 text-black" />
            </div>
            <h1 className="text-lg font-semibold tracking-tight">TriArb <span className="text-emerald-500">Pro</span></h1>
          </div>
          
          <div className="flex items-center gap-6">
            <div className="flex items-center gap-2">
              <div className={`flex items-center gap-2 px-3 py-1 rounded-full text-xs font-medium border ${isBotRunning ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400' : 'bg-zinc-500/10 border-zinc-500/20 text-zinc-400'}`}>
                <div className={`w-1.5 h-1.5 rounded-full ${isBotRunning ? 'bg-emerald-500 animate-pulse' : 'bg-zinc-500'}`} />
                {isBotRunning ? 'Simulation Mode Active' : 'Simulation Mode Standby'}
              </div>
              {hasApiKeys && (
                <div className="flex items-center gap-2 px-2 py-1 rounded-full bg-zinc-800 border border-white/10 text-zinc-400 text-[10px] font-bold uppercase tracking-tighter">
                  <Zap className="w-3 h-3" />
                  API Connected
                </div>
              )}
            </div>
            
            <div className="h-8 w-px bg-white/5" />

            <div className="flex items-center gap-3">
              <div className="text-right hidden sm:block">
                <div className="text-xs font-medium text-white">{user.displayName}</div>
                <button onClick={handleLogout} className="text-[10px] text-zinc-500 hover:text-red-400 transition-colors">Sign Out</button>
              </div>
              {user.photoURL ? (
                <img src={user.photoURL} alt="User" className="w-8 h-8 rounded-full border border-white/10" referrerPolicy="no-referrer" />
              ) : (
                <div className="w-8 h-8 rounded-full bg-zinc-800 flex items-center justify-center border border-white/10">
                  <User className="w-4 h-4 text-zinc-500" />
                </div>
              )}
            </div>

            <button 
              onClick={toggleBot}
              className={`flex items-center gap-2 px-4 py-2 rounded-xl font-medium transition-all active:scale-95 ${
                isBotRunning 
                ? 'bg-red-500/10 text-red-400 hover:bg-red-500/20 border border-red-500/20' 
                : 'bg-emerald-500 text-black hover:bg-emerald-400 shadow-[0_0_20px_rgba(16,185,129,0.2)]'
              }`}
            >
              {isBotRunning ? <Square className="w-4 h-4 fill-current" /> : <Play className="w-4 h-4 fill-current" />}
              {isBotRunning ? 'Stop Bot' : 'Start Bot'}
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-8 grid grid-cols-1 lg:grid-cols-3 gap-6">
        
        {/* Left Column: Stats & Triangle */}
        <div className="lg:col-span-2 space-y-6">
          
          {storageError && (
            <div className="bg-amber-500/10 border border-amber-500/20 rounded-2xl p-4 flex items-center gap-3 text-amber-400 text-sm">
              <AlertCircle className="w-5 h-5 shrink-0" />
              <p>{storageError}</p>
            </div>
          )}
          
          {/* Real-time Triangle View */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <TickerCard pair="ETH/BTC" data={memoizedTickerData['ETH/BTC']} />
            <TickerCard pair="ETH/USDT" data={memoizedTickerData['ETH/USDT']} />
            <TickerCard pair="BTC/USDT" data={memoizedTickerData['BTC/USDT']} />
          </div>

          {/* Profit Chart */}
          <div className="bg-zinc-900/50 border border-white/5 rounded-2xl p-6">
            <div className="flex items-center justify-between mb-8">
              <div>
                <h2 className="text-sm font-medium text-zinc-400">Arbitrage Opportunity History</h2>
                <p className="text-xs text-zinc-600">Profit percentage over the last 30 cycles</p>
              </div>
              <div className="text-right">
                <div className={`text-2xl font-mono font-bold tracking-tighter ${opportunity && opportunity.profitPercent > 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                  {opportunity ? `${opportunity.profitPercent.toFixed(4)}%` : '0.0000%'}
                </div>
                <div className="text-[10px] text-zinc-500 uppercase">Current Spread</div>
              </div>
            </div>
            
            <div className="h-[300px] w-full">
              <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={0}>
                <AreaChart data={memoizedHistory}>
                  <defs>
                    <linearGradient id="colorProfit" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#10b981" stopOpacity={0.3}/>
                      <stop offset="95%" stopColor="#10b981" stopOpacity={0}/>
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#ffffff05" vertical={false} />
                  <XAxis 
                    dataKey="time" 
                    stroke="#52525b" 
                    fontSize={10} 
                    tickLine={false} 
                    axisLine={false} 
                  />
                  <YAxis 
                    stroke="#52525b" 
                    fontSize={10} 
                    tickLine={false} 
                    axisLine={false} 
                    tickFormatter={(val) => `${val.toFixed(2)}%`}
                  />
                  <Tooltip 
                    contentStyle={{ backgroundColor: '#18181b', border: '1px solid #ffffff10', borderRadius: '8px' }}
                    itemStyle={{ color: '#10b981' }}
                  />
                  <Area 
                    type="monotone" 
                    dataKey="profit" 
                    stroke="#10b981" 
                    fillOpacity={1} 
                    fill="url(#colorProfit)" 
                    strokeWidth={2}
                    isAnimationActive={false}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Successful Trades Table */}
          <div className="bg-zinc-900/50 border border-white/5 rounded-2xl p-6 overflow-hidden">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-sm font-medium flex items-center gap-2">
                <History className="w-4 h-4 text-emerald-500" />
                Firestore History
              </h2>
              <span className="text-[10px] text-zinc-500 font-mono uppercase tracking-widest">Last 100 Hits</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="text-[10px] text-zinc-500 uppercase tracking-wider border-b border-white/5">
                    <th className="pb-3 font-medium">Date & Time</th>
                    <th className="pb-3 font-medium text-center">Loop</th>
                    <th className="pb-3 font-medium text-right">Profit %</th>
                    <th className="pb-3 font-medium text-right">Net Profit (BTC)</th>
                    <th className="pb-3 font-medium text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  <AnimatePresence initial={false}>
                    {memoizedTradesHistory.map((trade) => (
                      <TradeRow key={trade.id} trade={trade} onSimulate={setSelectedSimulationTrade} />
                    ))}
                  </AnimatePresence>
                  {memoizedTradesHistory.length === 0 && (
                    <tr>
                      <td colSpan={4} className="py-12 text-center text-zinc-600 text-xs italic">
                        No profitable opportunities recorded in Firestore yet...
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {/* Right Column: Logs & Settings */}
        <div className="space-y-6">
          
          {/* Bot Status Card */}
          <div className="bg-zinc-900/50 border border-white/5 rounded-2xl p-6">
            <h2 className="text-sm font-medium mb-4 flex items-center gap-2">
              <Settings className="w-4 h-4 text-zinc-500" />
              Configuration
            </h2>
            <div className="space-y-4">
              <div className="p-3 bg-black/40 rounded-xl border border-white/5">
                <div className="text-[10px] text-zinc-500 uppercase mb-1">Exchange</div>
                <div className="text-sm font-medium">Phemex.com</div>
              </div>
              <div className="p-3 bg-black/40 rounded-xl border border-white/5">
                <div className="text-[10px] text-zinc-500 uppercase mb-1">Database</div>
                <div className="text-sm font-medium text-emerald-400 flex items-center gap-2">
                  <CheckCircle2 className="w-3 h-3" />
                  Cloud Firestore
                </div>
              </div>
              <div className="p-3 bg-black/40 rounded-xl border border-white/5">
                <div className="text-[10px] text-zinc-500 uppercase mb-1">Min. Profit Threshold</div>
                <div className="text-sm font-medium">0.10%</div>
              </div>
              <div className="pt-2">
                <div className="flex items-center gap-2 p-3 rounded-xl bg-emerald-500/5 border border-emerald-500/10 text-emerald-200/70 text-[11px] leading-relaxed">
                  <Info className="w-4 h-4 shrink-0" />
                  Simulation Mode is active. All trades are virtual and do not use real funds.
                </div>
              </div>
            </div>
          </div>

          {/* Activity Logs */}
          <div className="bg-zinc-900/50 border border-white/5 rounded-2xl flex flex-col h-[500px]">
            <div className="p-4 border-b border-white/5 flex items-center justify-between">
              <h2 className="text-sm font-medium flex items-center gap-2">
                <History className="w-4 h-4 text-zinc-500" />
                Live Activity
              </h2>
              <span className="text-[10px] text-zinc-600 font-mono">{logs.length} events</span>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-3 custom-scrollbar">
              <AnimatePresence initial={false}>
                {memoizedLogs.map((log) => (
                  <LogItem key={log.id} log={log} />
                ))}
              </AnimatePresence>
              {memoizedLogs.length === 0 && (
                <div className="h-full flex flex-col items-center justify-center text-zinc-600 space-y-2 opacity-50">
                  <Activity className="w-8 h-8" />
                  <span className="text-xs">Waiting for activity...</span>
                </div>
              )}
            </div>
          </div>

        </div>
      </main>

      {/* Simulation Modal */}
      <AnimatePresence>
        {selectedSimulationTrade && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-6">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setSelectedSimulationTrade(null)}
              className="absolute inset-0 bg-black/80 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              className="relative w-full max-w-lg bg-zinc-900 border border-white/10 rounded-3xl overflow-hidden shadow-2xl"
            >
              <div className="p-6 border-b border-white/5 flex items-center justify-between bg-zinc-800/50">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-emerald-500/10 rounded-xl flex items-center justify-center border border-emerald-500/20">
                    <Calculator className="w-5 h-5 text-emerald-500" />
                  </div>
                  <div>
                    <h2 className="text-lg font-bold text-white">Trade Simulator</h2>
                    <p className="text-[10px] text-zinc-500 uppercase tracking-widest">Phemex Exchange Simulation</p>
                  </div>
                </div>
                <button 
                  onClick={() => setSelectedSimulationTrade(null)}
                  className="w-8 h-8 rounded-full bg-white/5 hover:bg-white/10 flex items-center justify-center transition-colors"
                >
                  <X className="w-4 h-4 text-zinc-400" />
                </button>
              </div>

              <div className="p-6 space-y-6">
                {/* Input Section */}
                <div className="space-y-2">
                  <label className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider">Initial BTC Amount</label>
                  <div className="relative">
                    <input 
                      type="number" 
                      value={simulationAmount}
                      onChange={(e) => setSimulationAmount(parseFloat(e.target.value) || 0)}
                      className="w-full bg-black border border-white/10 rounded-2xl py-4 px-6 text-xl font-mono focus:outline-none focus:border-emerald-500/50 transition-colors"
                      step="0.01"
                      min="0.0001"
                    />
                    <div className="absolute right-6 top-1/2 -translate-y-1/2 text-zinc-500 font-mono text-sm">BTC</div>
                  </div>
                </div>

                {/* Calculation Steps */}
                <div className="space-y-3">
                  <div className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider">Execution Steps (0.1% Fee per Trade)</div>
                  
                  {(() => {
                    const fee = 0.001; // 0.1%
                    const prices = selectedSimulationTrade.details?.prices || {};
                    const step1_eth = simulationAmount / (prices['ETH/BTC'] || 1) * (1 - fee);
                    const step2_usdt = step1_eth * (prices['ETH/USDT'] || 1) * (1 - fee);
                    const step3_btc = step2_usdt / (prices['BTC/USDT'] || 1) * (1 - fee);
                    const netProfit = step3_btc - simulationAmount;
                    const netProfitPercent = (netProfit / simulationAmount) * 100;

                    return (
                      <div className="space-y-2">
                        <div className="flex items-center gap-3 p-3 bg-black/40 rounded-xl border border-white/5">
                          <div className="w-6 h-6 rounded-full bg-zinc-800 flex items-center justify-center text-[10px] font-bold text-zinc-500">1</div>
                          <div className="flex-1 text-xs">BTC → ETH</div>
                          <div className="text-xs font-mono text-zinc-400">{step1_eth.toFixed(8)} ETH</div>
                        </div>
                        <div className="flex items-center gap-3 p-3 bg-black/40 rounded-xl border border-white/5">
                          <div className="w-6 h-6 rounded-full bg-zinc-800 flex items-center justify-center text-[10px] font-bold text-zinc-500">2</div>
                          <div className="flex-1 text-xs">ETH → USDT</div>
                          <div className="text-xs font-mono text-zinc-400">{step2_usdt.toFixed(2)} USDT</div>
                        </div>
                        <div className="flex items-center gap-3 p-3 bg-black/40 rounded-xl border border-white/5">
                          <div className="w-6 h-6 rounded-full bg-zinc-800 flex items-center justify-center text-[10px] font-bold text-zinc-500">3</div>
                          <div className="flex-1 text-xs">USDT → BTC</div>
                          <div className="text-xs font-mono text-zinc-400">{step3_btc.toFixed(8)} BTC</div>
                        </div>

                        <div className="mt-6 p-6 bg-emerald-500/5 border border-emerald-500/20 rounded-2xl">
                          <div className="flex justify-between items-end">
                            <div>
                              <div className="text-[10px] text-emerald-500/70 font-bold uppercase mb-1">Net Simulation Result</div>
                              <div className={`text-3xl font-mono font-bold tracking-tighter ${netProfit >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                                {netProfit >= 0 ? '+' : ''}{netProfit.toFixed(8)} BTC
                              </div>
                            </div>
                            <div className={`text-xl font-mono font-bold ${netProfit >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
                              {netProfitPercent.toFixed(4)}%
                            </div>
                          </div>
                          <div className="mt-4 pt-4 border-t border-emerald-500/10 flex justify-between text-[10px] text-zinc-500 uppercase font-medium">
                            <span>Total Fees: 0.3%</span>
                            <span>Market: {selectedSimulationTrade.details?.prices['ETH/BTC'].toFixed(6)} / {selectedSimulationTrade.details?.prices['ETH/USDT'].toFixed(2)} / {selectedSimulationTrade.details?.prices['BTC/USDT'].toFixed(2)}</span>
                          </div>
                        </div>
                      </div>
                    );
                  })()}
                </div>
              </div>

              <div className="p-6 bg-black/20 border-t border-white/5">
                <button 
                  onClick={() => setSelectedSimulationTrade(null)}
                  className="w-full py-4 bg-white text-black rounded-2xl font-bold hover:bg-zinc-200 transition-all active:scale-95"
                >
                  Close Simulator
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      <style>{`
        .custom-scrollbar::-webkit-scrollbar {
          width: 4px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: transparent;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: #27272a;
          border-radius: 10px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: #3f3f46;
        }
      `}</style>
    </div>
  );
}

export default App;
