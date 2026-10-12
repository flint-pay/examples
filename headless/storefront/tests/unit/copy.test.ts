import {test} from 'node:test';
import assert from 'node:assert/strict';
import {declineMessage,intervalUnit} from '../../src/copy.ts';

test('billing interval units follow the public billing_interval values and pluralize by count',()=>{
  const expected={daily:'day',weekly:'week',monthly:'month',yearly:'year'};
  for(const [interval,unit] of Object.entries(expected)){
    assert.equal(intervalUnit(interval,1),unit);assert.equal(intervalUnit(interval,2),`${unit}s`);
    assert.equal(intervalUnit(unit,1),unit,'the singular alias still works');assert.equal(intervalUnit(unit,3),`${unit}s`);
  }
});

test('insufficient funds guidance uses bank copy only for the failed ACH legs', async()=>{
  const {declineMessageCode}=await import('../../public/js/checkout-logic.js');
  const state=(types:string[],failed:string[]=types.map((_,i)=>`pi_${i}`))=>({
    attempt:{failure_code:'insufficient_funds',payment_intents:types.map((_,i)=>({payment_intent_id:`pi_${i}`,status:failed.includes(`pi_${i}`)?'requires_payment_method':'succeeded'}))},
    order:{payment_intents:types.map((type,i)=>({payment_intent_id:`pi_${i}`,payment_source:{type}}))},
  }) as unknown as Parameters<typeof declineMessageCode>[0];
  assert.match(declineMessage(declineMessageCode(state(['ach_debit']))),/Your bank declined.*not enough funds/);
  assert.match(declineMessage(declineMessageCode(state(['card']))),/^This payment was declined/);
  assert.equal(declineMessageCode(state(['ach_debit','card'])), 'insufficient_funds');
  assert.equal(declineMessageCode(state(['card','ach_debit'],['pi_1'])), 'bank_insufficient_funds');
  assert.equal(declineMessageCode(state(['unknown'])), 'insufficient_funds');
  assert.equal(declineMessageCode(state(['ach_debit'],[])), 'insufficient_funds');
  const other=state(['ach_debit']);other.attempt!.failure_code='bank_account_closed';
  assert.equal(declineMessageCode(other),'bank_account_closed');
});
