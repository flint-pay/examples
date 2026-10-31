import test from 'node:test';
import {readdirSync,readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {SdkError} from '@flintpay/node';
import {flintError} from './support/flint-error.ts';
import type {CheckoutSession} from '@flintpay/node';
import {trustedChallengeUrl,challengeFromError,confirmWithSession,newChallengeId,sessionTag,validProof,challengeOrigin} from '../../src/server/flint/gift-challenge.ts';
import {readConfig} from '../../src/server/config.ts';
import {securityHeaders} from '../../src/server/security/headers.ts';
import {safeSession,buyerSafe} from '../../src/server/flint/projection.ts';
import {redact} from '../../src/server/security/log.ts';
const origin='https://checkout.staging.withflintpay.com',url=`${origin}/gift-card-challenge/gccf_fixture.token`;
// Flint answers the challenge with 409: the reason is the first detail's, and the remediation is the error's own.
type Fixture={reason?:string;remediation?:{retry:string;next_actions?:unknown[]}|null};
const error=(fixture:Fixture,status=409,code='GIFT_CARD_CHALLENGE_REQUIRED')=>flintError(status,code,fixture.reason?{reason:fixture.reason}:{},fixture.remediation===undefined?{retry:'none'}:fixture.remediation);
const details=(reason='proof_required',urls=[url]):Fixture=>({reason,remediation:{retry:'none',next_actions:urls.map(url=>({action_type:'complete_gift_card_challenge',url}))}});
test('U1 exact trusted URLs reject ambiguous serialization, hosts, paths and authority',()=>{
  assert.equal(trustedChallengeUrl(url,origin),url);assert.equal(trustedChallengeUrl('https://checkout.withflintpay.com/gift-card-challenge/token','https://checkout.withflintpay.com'),'https://checkout.withflintpay.com/gift-card-challenge/token');
  for(const raw of [null,42,url.replace('https:','http:'),url.replace('checkout.staging','CHECKOUT.STAGING'),url.replace('checkout.staging.withflintpay.com','checkout.staging.withflintpay.com.evil.example'),url.replace('checkout.staging','api.staging'),url.replace('staging.',''),url.replace('https://','https://user@'),url.replace('.com/','.com:443/'),url+'?x=1',url+'#x',origin+'/gift-card-challenge',origin+'/gift-card-challenge/',origin+'/prefix/gift-card-challenge/token',url+'/extra',origin+'/gift-card-challenge/%74oken',origin+'/gift-card-challenge/'+ 'x'.repeat(257),'x'.repeat(2049)])assert.equal(trustedChallengeUrl(raw,origin),null,String(raw));
});
test('U2 challenge reason and remediation are read from SdkError.details and fail closed',()=>{
  for(const reason of ['proof_required','proof_rejected'])assert.deepEqual(challengeFromError(error(details(reason)),origin),{kind:'challenge',reason,url});
  assert.deepEqual(challengeFromError(error({reason:'page_origin_required'}),origin),{kind:'origin_required'});
  for(const value of [{},{reason:'future_reason'}])assert.deepEqual(challengeFromError(error(value),origin),{kind:'unavailable',cause:'reason_unknown'});
  for(const value of [details('proof_required',[]),details('proof_required',[url,url]),{reason:'proof_required',remediation:{retry:'none',next_actions:[{action_type:'other',url}]}}])assert.deepEqual(challengeFromError(error(value),origin),{kind:'unavailable',cause:'next_action_missing'});
  assert.deepEqual(challengeFromError(error(details('proof_required',['https://evil.example/x'])),origin),{kind:'unavailable',cause:'url_untrusted'});
  assert.deepEqual(challengeFromError(error(details(),400),origin),{kind:'unavailable',cause:'reason_unknown'});
  assert.equal(challengeFromError(new Error('local'),origin),null);assert.equal(challengeFromError(error(details(),409,'OTHER'),origin),null);
});
test('U3 session confirmation binds the current open session and exact URL',async()=>{
  const outcome={kind:'challenge' as const,reason:'proof_required' as const,url},session={checkout_session_id:'session_fixture',status:'open',is_in_recovery:false,gift_card_challenge:{url}};
  assert.deepEqual(await confirmWithSession(outcome,async()=>session as unknown as CheckoutSession,'session_fixture'),outcome);
  for(const patch of [{checkout_session_id:'different'},{status:'closed'},{is_in_recovery:true},{gift_card_challenge:undefined},{gift_card_challenge:{url:url+'different'}}])assert.deepEqual(await confirmWithSession(outcome,async()=>({...session,...patch}) as unknown as CheckoutSession,'session_fixture'),{kind:'unavailable',cause:'session_mismatch'});
  assert.deepEqual(await confirmWithSession(outcome,async()=>{throw flintError(409,'ACTION_NOT_ALLOWED',{reason:'terminal_status',resource_type:'checkout_session'});},'session_fixture'),{kind:'unavailable',cause:'session_not_open'});
  await assert.rejects(()=>confirmWithSession(outcome,async()=>{throw new Error('unknown read');},'session_fixture'));
});
test('U4 pinned session tag and fresh opaque challenge references',()=>{
  assert.equal(sessionTag('gch_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA','cs_PLACEHOLDER_PINNED_VECTOR'),'CGZN0PgNBeNrKsatRzXixdZjmjeaolCFm462W42PkeU');const ids=Array.from({length:20},newChallengeId);assert.equal(new Set(ids).size,20);for(const id of ids)assert.match(id,/^gch_[A-Za-z0-9_-]{32}$/);
});
test('U5 proof validation is opaque printable ASCII, including its exact size boundaries',()=>{
  for(const raw of ['!', 'x'.repeat(2048)])assert.equal(validProof(raw),true);
  for(const raw of ['', 'x'.repeat(2049),' ', 'x y','x\r','x\n','é',null,42])assert.equal(validProof(raw),false);
});
test('U6 configuration follows Flint page-origin rules and the fixed challenge origin map',()=>{
  const env={FLINT_API_KEY:'flint_test_FIXTURE',FLINT_API_BASE_URL:'https://api.staging.withflintpay.com',APP_ORIGIN:'http://localhost:4100',PORT:'4100'};
  for(const appOrigin of ['http://localhost:3000','http://127.0.0.1:4100','http://shop.localhost:3000','https://shop.example.com'])assert.equal(readConfig({...env,APP_ORIGIN:appOrigin}).appOrigin,appOrigin);
  for(const appOrigin of ['http://[::1]:3000','https://10.0.0.5','https://withflintpay.com','https://shop.withflintpay.com','http://localhost:0','https://'+ 'x'.repeat(64)+'.example.com'])assert.throws(()=>readConfig({...env,APP_ORIGIN:appOrigin}));
  assert.equal(challengeOrigin(env.FLINT_API_BASE_URL),origin);assert.equal(challengeOrigin('https://api.withflintpay.com'),'https://checkout.withflintpay.com');assert.throws(()=>challengeOrigin('https://evil.example'));
});
test('U7 only frame-src admits the configured challenge origin',()=>{
  const headers=securityHeaders({giftChallengeOrigin:origin}),csp=headers['Content-Security-Policy'];assert.equal(csp.split(origin).length,2);assert.match(csp,/frame-ancestors 'none'/);assert.match(csp,new RegExp('frame-src[^;]*'+origin.replaceAll('.','\\.')));assert.equal(csp.includes('*.withflintpay.com'),false);
  for(const directive of ['script-src','connect-src'])assert.equal(csp.split(';').find(part=>part.trim().startsWith(directive))?.includes(origin),false);
});
test('U9 challenge authority is removed from log text',()=>{for(const raw of ['gccp_fixture-proof','gccf_fixture.token','/gift-card-challenge/frame.token'])assert.equal(redact(raw),'[redacted]');});

test('U10 session and recursive projection remove the challenge descriptor and page origin',()=>{const session={checkout_session_id:'cs_fixture',gift_card_challenge:{url},page_origin:'http://localhost:4100',status:'open'} as unknown as CheckoutSession;const serialized=JSON.stringify(safeSession(session));assert.equal(serialized.includes('gift_card_challenge'),false);assert.equal(serialized.includes('page_origin'),false);assert.deepEqual(buyerSafe({nested:{gift_card_challenge:{url},page_origin:'http://localhost:4100',status:'open'}}),{nested:{status:'open'}});});

test('U8 the proof header is built only in the bounded gift challenge module',()=>{
 const visit=(root:URL):string[]=>readdirSync(root,{withFileTypes:true}).flatMap(entry=>{const path=new URL(entry.name+(entry.isDirectory()?'/':''),root);return entry.isDirectory()?visit(path):entry.name.endsWith('.ts')&&readFileSync(path,'utf8').includes('Flint-Gift-Card-Challenge')?[path.pathname]:[];});
 assert.deepEqual(visit(new URL('../../src/server/',import.meta.url)).map(path=>path.split('/src/')[1]),['server/flint/gift-challenge.ts']);
});
