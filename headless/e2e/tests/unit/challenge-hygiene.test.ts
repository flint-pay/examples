import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readdir,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ChallengeLogCapture,serveChallengeLogScan,assertChallengeLogs} from '../../support/challenge-hygiene.ts';
test('full captured child streams detect code and split proof text without persisting output',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'challenge-log-unit-')),capture=new ChallengeLogCapture(),close=await serveChallengeLogScan(directory,'fixture-run','fixture-commit',capture);
  try{
    capture.capture('storefrontA','stdout','{"event":"safe"}\n');await assertChallengeLogs(directory,'fixture-run','fixture-commit','SF-GIFTCHALLENGE',['GIFT-FIXTURE-CODE']);
    capture.capture('storefrontA','stderr','gift code: GIFT-FIX');capture.capture('storefrontA','stderr','TURE-CODE');await assert.rejects(()=>assertChallengeLogs(directory,'fixture-run','fixture-commit','SF-GIFTCHALLENGE',['GIFT-FIXTURE-CODE']),{code:'CHALLENGE_AUTHORITY_IN_APP_LOGS'});
    capture.capture('accountA','stdout','gcc');capture.capture('accountA','stdout','p_fixture-secret-proof');await assert.rejects(()=>assertChallengeLogs(directory,'fixture-run','fixture-commit','AC-GIFTCHALLENGE',['OTHER-FIXTURE-CODE']),{code:'CHALLENGE_AUTHORITY_IN_APP_LOGS'});
    assert.deepEqual(await readdir(directory),['challenge-hygiene.sock']);
    await assert.rejects(()=>assertChallengeLogs(directory,'foreign-run','fixture-commit','AC-GIFTCHALLENGE',['OTHER-FIXTURE-CODE']),{code:'CHALLENGE_AUTHORITY_IN_APP_LOGS'});
  }finally{await close();assert.deepEqual(await readdir(directory),[]);await rm(directory,{recursive:true,force:true});}
});
test('frame authority and incomplete capture cannot produce clean evidence',()=>{
 for(const value of ['gccf_fixture.token','/gift-card-challenge/frame']){const capture=new ChallengeLogCapture();capture.capture('storefrontA','stdout',value);assert.equal(capture.clean('storefrontA',['GIFT-FIXTURE']),false);}
 const capture=new ChallengeLogCapture();capture.capture('storefrontA','stderr','x'.repeat(16*1024*1024+1));assert.equal(capture.clean('storefrontA',['GIFT-FIXTURE']),false);
});
