import {describe,it,expect,vi,afterEach} from 'vitest';
const mocks=vi.hoisted(()=>({recover:vi.fn(),sql:vi.fn(),keys:vi.fn(),read:vi.fn()}));
vi.mock('../fresh-start/runtime.js',()=>({FreshRuntime:class{recover=mocks.recover;}}));
vi.mock('../../lib/db.js',()=>({sql:mocks.sql}));
vi.mock('../../lib/redis.js',()=>({redis:{get:mocks.read},scanKeys:mocks.keys}));
vi.mock('../ensure-capture-schema.js',()=>({schemaFileReady:()=>true}));
import {FreshPaperWorker} from '../fresh-start/worker.js';
import {freshAdapterState as state} from '../fresh-start/adapter-state.js';
afterEach(()=>vi.useRealTimers());
function setup(){const provider={getInstrumentMaster:vi.fn(),getHistoricalData:vi.fn(),isAuthenticated:vi.fn()},manager={onTick:vi.fn(()=>()=>{}),onRecovering:vi.fn(()=>()=>{}),unsubscribe:vi.fn(),getStatus:()=>({subscriptionCount:0})};return {provider,worker:new FreshPaperWorker(provider as any,manager as any)};}
describe('production worker lifecycle',()=>{
 it('registers timers synchronously before recovery and does no provider work on a weekend',async()=>{vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-31T06:00:00Z'));let release!:()=>void;mocks.recover.mockImplementation(()=>new Promise<void>(r=>release=r));const {worker,provider}=setup();const started=worker.start();expect(vi.getTimerCount()).toBe(2);expect(state.entriesArmed).toBe(false);release();await started;expect(state.status).toBe('WAITING_FOR_MARKET');expect(provider.getInstrumentMaster).not.toHaveBeenCalled();expect(provider.getHistoricalData).not.toHaveBeenCalled();worker.stop();expect(vi.getTimerCount()).toBe(0);expect(state.monitorRunning).toBe(false);});
 it('keeps activation blocked after a recovery failure',async()=>{mocks.recover.mockRejectedValue(Error('storage unavailable'));const {worker}=setup();await expect(worker.start()).rejects.toThrow('storage unavailable');expect(state.entriesArmed).toBe(false);expect(state.status).toBe('BLOCKED_RECOVERY');worker.stop();});
 it('ignores explicitly inactive Redis placeholders while blocking active or unreadable legacy inventory',async()=>{mocks.sql.mockResolvedValue([{n:0}]);mocks.keys.mockResolvedValue(['trade_setup:NSE:NIFTY:INTRADAY']);const {worker}=setup();mocks.read.mockResolvedValue(JSON.stringify({available:false}));expect(await (worker as any).legacyRisk()).toBe(false);mocks.read.mockResolvedValue(JSON.stringify({available:true}));expect(await (worker as any).legacyRisk()).toBe(true);mocks.read.mockResolvedValue('{bad');expect(await (worker as any).legacyRisk()).toBe(true);mocks.sql.mockRejectedValue(Error('db'));expect(await (worker as any).legacyRisk()).toBe(true);});

});
