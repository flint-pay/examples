import {test} from 'node:test';
import assert from 'node:assert/strict';
import {makeMoneyValue,SdkError} from '@flintpay/node';
import type {Order,OrderPaymentAttempt} from '@flintpay/node';
import {returnPath} from '../../src/security/paths.ts';
import {decimalMinor,formatMoney,moneyEqual} from '../../src/security/money.ts';
import {RateLimiter} from '../../src/security/rate-limit.ts';
import {redact} from '../../src/security/log.ts';
import {buyerSafe,safeAttempt,safeOrder} from '../../src/flint/projection.ts';
import {appError,unknownOutcome} from '../../src/flint/errors.ts';

for(const path of ['https://outside.example','//outside.example','/\\outside.example','/%2foutside.example','/%5coutside.example','/next%0aLocation:outside','/next\u0000','/bad%zz'])test(`return path rejects ${JSON.stringify(path)}`,()=>assert.equal(returnPath(path),'/'));
test('return path preserves local resource and query hints',()=>assert.equal(returnPath('/orders/example?invoice_id=example&notice=sent#receipt'),'/orders/example?invoice_id=example&notice=sent#receipt'));
test('money uses exact integers above the safe Number range',()=>{
  assert.equal(moneyEqual({amount:'00018',currency:'USD'},{amount:'18',currency:'USD'}),true);assert.equal(moneyEqual({amount:'18',currency:'USD'},{amount:'18',currency:'CAD'}),false);
  assert.equal(decimalMinor('12.03'),'1203');assert.equal(decimalMinor('0.5'),'50');assert.throws(()=>decimalMinor('1e3'));assert.throws(()=>decimalMinor('0.001'));assert.throws(()=>decimalMinor('-1'));
  assert.equal(formatMoney({amount:'900719925474099199',currency:'USD'}),'$9,007,199,254,740,991.99');assert.equal(formatMoney({amount:'-123',currency:'USD'}),'-$1.23');assert.equal(formatMoney({amount:'123',currency:'JPY'}),'¥123');
});
test('rate limit admission caps the bucket and isolates distinct keys',()=>{
  const limits=new RateLimiter();assert.equal(limits.take('buyer-a',2,1000),true);assert.equal(limits.take('buyer-a',2,1000),true);assert.equal(limits.take('buyer-a',2,1000),false);assert.equal(limits.take('buyer-b',2,1000),true);
});
test('buyer projections remove Flint and provider credentials recursively, including SDK models',()=>{
  const apiKey=['flint','test','fixture'].join('_');const safe=buyerSafe({label:'Safe item',nested:{checkout_session_id:'example-session',checkout_auth_token:'private',refresh_token:'private',secret:'private',client_secret:'pi_fixture_secret_fixture',client_action:{stripe:{secret:'private'}},metadata:{private:'value'},note:apiKey},items:[{name:'one',secret:'private'}],price:makeMoneyValue({amount:'18',currency:'USD'})});
  assert.deepEqual(safe,{label:'Safe item',nested:{},items:[{name:'one'}],price:{amount:'18',currency:'USD'}});
});
test('provider action secrets stay out of initial order and attempt projections',()=>{
  const attempt={status:'requires_action',pending_actions:[{pending_action_id:'example-action',client_action:{stripe:{payment_intent:{client_secret:'pi_fixture_secret_fixture'}}}}]} as unknown as OrderPaymentAttempt;
  const serialized=JSON.stringify(safeOrder({active_payment_attempt:attempt} as Order));assert.equal(serialized.includes('_secret_'),false);assert.equal(serialized.includes('client_action'),false);
  assert.equal(JSON.stringify(safeAttempt({...attempt,status:'processing'})).includes('pending_actions'),false);
});
test('logs redact API credentials, provider secrets, and verification codes',()=>{
  const value=`${['flint','test','fixture'].join('_')} pi_fixture_secret_fixture 123456`;
  assert.equal(redact(value),'[redacted] [redacted] [redacted]');
});
test('unknown outcomes and unavailable gift backing stay retryable without leaking SDK details',()=>{
  const error=new SdkError('server','sensitive provider text','response',true,{status:503,headers:{},attempts:1,durationMs:1,requestId:'example-request'},'GIFT_CARDS_UNAVAILABLE',{private:'value'});
  assert.equal(unknownOutcome(error),true);assert.deepEqual(appError(error),{kind:'unknown_outcome',code:'GIFT_CARDS_UNAVAILABLE',message_key:'gift_cards_unavailable',request_id:'example-request'});
  assert.equal(JSON.stringify(appError(error)).includes('sensitive'),false);
});
