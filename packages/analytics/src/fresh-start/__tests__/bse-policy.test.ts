import {describe,it,expect} from 'vitest';
import {admitFreshPaper} from '../paper.js';
import {request} from './fixtures.js';
const bse=()=>{const r=request();return {...r,contract:{...r.contract,market:'BSE_VERIFIED_OPTIONS' as const,marketPolicy:'BSE_INDEX_1_10_PAPER_V1' as const}};};
describe('explicit BSE index paper admission policy',()=>{
 it('admits qualified BSE contracts only with the explicit product policy marker',()=>{const r=bse();expect(admitFreshPaper(r).ok).toBe(true);const {marketPolicy,...contract}=r.contract;expect(admitFreshPaper({...r,contract})).toEqual({ok:false,code:'MARKET_DISCOVERY_ONLY'});});
 it('rejects zero DTE and out-of-policy expiries while admitting both boundaries',()=>{for(const n of [0,11,1.5])expect(admitFreshPaper({...bse(),contract:{...bse().contract,expiryTradableSessions:n}})).toEqual({ok:false,code:'EXPIRY_INELIGIBLE'});for(const n of [1,10])expect(admitFreshPaper({...bse(),contract:{...bse().contract,expiryTradableSessions:n}}).ok).toBe(true);});
 it('uses the tighter index spread rather than the stock spread',()=>{const r=bse();expect(admitFreshPaper({...r,quote:{...r.quote,bid:99.3,ask:100.5}})).toEqual({ok:false,code:'WIDE_SPREAD'});});
 it('never uses the BSE policy marker to admit MCX or bypass event/metadata gates',()=>{const r=bse();expect(admitFreshPaper({...r,contract:{...r.contract,market:'MCX_VERIFIED_FUTURES_OPTIONS'}})).toEqual({ok:false,code:'MARKET_DISCOVERY_ONLY'});expect(admitFreshPaper({...r,eventClear:false})).toEqual({ok:false,code:'BLOCKED_REQUIRED_CAPABILITY'});expect(admitFreshPaper({...r,contract:{...r.contract,metadataVerified:false}})).toEqual({ok:false,code:'BLOCKED_REQUIRED_CAPABILITY'});});
});
