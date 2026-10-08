import test from 'node:test';
import assert from 'node:assert/strict';
import { unresolvedSuitePrerequisites, prerequisites,giftChallengeSdkReady,giftChallengeReadiness } from '../../support/readiness.ts';
import { rows } from '../../scenarios/registry.ts';
import { Results } from '../../support/results.ts';

test('fixture checks fail pending roots without counting unexecuted or blocked coverage as passing', () => {
  const results = new Results('/tmp/unused-unit-readiness.json', rows.map(row => row.id));
  for (const id of new Set(rows.flatMap(row => prerequisites(row.id)))) results.root({ id, code: 'UNIT', status: 'RESOLVED' });
  results.roots.set('PRQ-GIFT-CHALLENGE', { id: 'PRQ-GIFT-CHALLENGE', code: 'UNIT_MISSING_CONTRACT', status: 'PENDING' });
  results.roots.set('PRQ-APP-VAULT-AUTHORITY', { id: 'PRQ-APP-VAULT-AUTHORITY', code: 'UNIT_SCOPE_STOP', status: 'BLOCKED' });
  assert.deepEqual(unresolvedSuitePrerequisites({ suite: 'standard' }, {}, results), ['PRQ-APP-VAULT-AUTHORITY', 'PRQ-GIFT-CHALLENGE']);
  assert.deepEqual(unresolvedSuitePrerequisites({ suite: 'extended' }, {}, results), ['PRQ-APP-VAULT-AUTHORITY', 'PRQ-GIFT-CHALLENGE']);
  const synthetic={...rows[0]!,id:'SF-TEST-EXCEPTION',prq:['PRQ-TEST-EXCEPTION']};rows.push(synthetic);
  try{
    results.root({id:'PRQ-TEST-EXCEPTION',status:'PENDING',code:'UNIT'});
    assert.deepEqual(unresolvedSuitePrerequisites({suite:'standard'},{},results),['PRQ-APP-VAULT-AUTHORITY','PRQ-GIFT-CHALLENGE','PRQ-TEST-EXCEPTION']);
    const acceptedExceptions=[{id:synthetic.id,acceptedByUser:true as const,reference:'UNIT_EXPLICIT_USER_EXCEPTION'}];
    assert.deepEqual(unresolvedSuitePrerequisites({suite:'standard'},{acceptedExceptions},results),['PRQ-APP-VAULT-AUTHORITY','PRQ-GIFT-CHALLENGE']);
  }finally{rows.pop();}

});

const candidate='3.0.0-beta.20261008013000';
const evidence=()=>Array.from({length:3},()=>({pin:candidate,installed:candidate,resolved:`https://registry.npmjs.org/@flintpay/node/-/node-${candidate}.tgz`}));
test('gift SDK readiness requires three matching published and installed registry packages',()=>{
  assert.equal(giftChallengeSdkReady(evidence()),true);
  for(const field of ['pin','installed','resolved'] as const){const values=evidence();values[1]![field]=field==='resolved'?'file:/tmp/candidate.tgz':'3.0.0-beta.20261007031000';assert.equal(giftChallengeSdkReady(values),false);}
  assert.equal(giftChallengeSdkReady(evidence().slice(1)),false);
  assert.equal(giftChallengeSdkReady(evidence().map(item=>({...item,pin:'3.0.0-beta.20261007031000',installed:'3.0.0-beta.20261007031000'}))),false);
});

test('public gift readiness stays pending until both registry pins and staging release attestation hold',()=>{
 const attestation={publicGiftChallenge:true,checkedAt:'2026-10-08T00:00:00Z'};assert.equal(giftChallengeReadiness(evidence(),attestation).ready,true);
 assert.deepEqual(giftChallengeReadiness(evidence(),{...attestation,publicGiftChallenge:false}),{ready:false,code:'STAGING_GIFT_CHALLENGE_RELEASE_REQUIRED'});
 assert.equal(giftChallengeReadiness(evidence(),{...attestation,checkedAt:''}).ready,false);
 assert.deepEqual(giftChallengeReadiness([],attestation),{ready:false,code:'PINNED_SDK_PUBLIC_GIFT_CHALLENGE_UNAVAILABLE'});
});
