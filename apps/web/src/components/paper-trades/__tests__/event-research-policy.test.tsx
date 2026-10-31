import React from 'react';
import {describe,it,expect,afterEach} from 'vitest';
import {render,screen,within,cleanup} from '@testing-library/react';
import {EventResearchPolicy} from '../event-research-policy';
const performance={strategy:'NEW_ORB_RETEST_V1',filled:1,closed:1,netPnl:-100,expectancyR:-.1,winRate:0};
const data:any={eventPolicy:{id:'PAPER_EVENT_UNVERIFIED_V1',allowMissingMacroCoverage:true},eventCohorts:[],positions:[]};
afterEach(cleanup);
describe('paper-only incomplete event research disclosure',()=>{
 it('shows the approved missing-data exception without claiming all execution gates or entries are ready',()=>{render(<EventResearchPolicy data={data} names={{}}/>);const banner=screen.getByRole('status',{name:'Paper event policy'});expect(banner).toHaveTextContent('EVENT_DATA_UNVERIFIED');expect(banner).toHaveTextContent('No paid calendar key is required');expect(banner).toHaveTextContent('Other qualification gates can still prevent a trade');expect(screen.getByText(/No fresh fills recorded yet/)).toBeInTheDocument();});
 it('keeps cohort profit/loss and historical unknown labels separate',()=>{const positions=[{strategy:performance.strategy,status:'CLOSED',state:{id:'one',contract:{id:'NSE_FO:1',evidence:{eventCalendar:{coverage:{evidenceClass:'EVENT_DATA_UNVERIFIED'}}}}}},{strategy:performance.strategy,status:'CLOSED',state:{id:'old'}}];render(<EventResearchPolicy data={{...data,eventCohorts:[{policyId:'new',evidenceClass:'EVENT_DATA_UNVERIFIED',performance:[performance]},{policyId:'strict',evidenceClass:'EVENT_COVERAGE_VERIFIED',performance:[{...performance,netPnl:200}]}],positions}} names={{NEW_ORB_RETEST_V1:'Opening range retest'}}/>);const t=screen.getByRole('table',{name:'Paper results by event evidence cohort'});expect(within(t).getByRole('rowheader',{name:'Event data unverified'})).toBeInTheDocument();expect(within(t).getByRole('rowheader',{name:'Event coverage verified'})).toBeInTheDocument();expect(t).toHaveTextContent('-₹100');expect(t).toHaveTextContent('₹200');expect(screen.getByText('EVENT_POLICY_UNRECORDED')).toBeInTheDocument();expect(screen.getByText(/overview combines event cohorts/)).toBeInTheDocument();});
 it('tolerates older status responses without inventing a policy',()=>{const {container}=render(<EventResearchPolicy data={{...data,eventPolicy:undefined}} names={{}}/>);expect(container).toBeEmptyDOMElement();});
});
