import React from 'react';
import {describe,it,expect,afterEach} from 'vitest';
import {render,screen,cleanup} from '@testing-library/react';
import type {FreshSessionEvidence} from '@fno/shared';
import {SessionEvidence} from '../session-evidence';
const report:FreshSessionEvidence={version:'FRESH_SESSION_EVIDENCE_V1',scope:'LATEST_100_CURRENT_VERSION',sampled:0,sampleTruncated:false,unclassified:0,markets:[{market:'NSE_INDEX_OPTIONS',sampled:0,consistentSessionClosed:0},{market:'MCX_VERIFIED_FUTURES_OPTIONS',sampled:0,consistentSessionClosed:0}],cohorts:[],note:'No automatic qualification or rule changes.'};
afterEach(cleanup);
describe('recorded session evidence disclosure',()=>{
 it('shows absent market evidence without declaring validation passed',()=>{render(<SessionEvidence report={report}/>);expect(screen.getByRole('table',{name:'Paper evidence by market'})).toHaveTextContent('MCX VERIFIED FUTURES OPTIONS');expect(screen.getAllByText('No consistent closed session record in sample')).toHaveLength(2);expect(screen.getByText(/strategy validation remains pending/)).toBeInTheDocument();});
 it('discloses event cohorts, pending exits, excluded markets and the sample boundary',()=>{render(<SessionEvidence report={{...report,sampled:3,sampleTruncated:true,unclassified:1,cohorts:[{market:'NSE_INDEX_OPTIONS',strategy:'NEW_ORB_RETEST_V1',policyId:'PAPER_EVENT_UNVERIFIED_V1',evidenceClass:'EVENT_DATA_UNVERIFIED',sampled:2,entryOnly:0,pending:1,closed:1,incomplete:0,inconsistent:0,sessionTimingUnproven:0,consistentSessionClosed:1,sessions:['2026-11-02']}]}}/>);expect(screen.getByRole('table',{name:'Session evidence by strategy and event policy'})).toHaveTextContent('0 / 1 / 1');expect(screen.getByText('EVENT_DATA_UNVERIFIED')).toBeInTheDocument();expect(screen.getByText('2026-11-02')).toBeInTheDocument();expect(screen.getByText(/excluded from market totals/)).toBeInTheDocument();expect(screen.getByText(/older sessions are outside/)).toBeInTheDocument();});
 it('works during a rolling deployment with an older API',()=>{const {container}=render(<SessionEvidence report={undefined}/>);expect(container).toBeEmptyDOMElement();});
});
