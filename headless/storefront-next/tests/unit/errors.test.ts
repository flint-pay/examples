import test from 'node:test';
import assert from 'node:assert/strict';
import {SdkError} from '@flintpay/node';
import {appError,condition,scopeOfPath,sessionEnded,unknownOutcome} from '../../src/server/flint/errors.ts';
import {flintError} from './support/flint-error.ts';

// Flint publishes shared codes and tells refusals apart by reason, request field and resource. The app names
// them by the condition its copy and flows branch on.
const cases:[string,SdkError,string|undefined,string][]=[
  ['a stale order version',flintError(409,'VERSION_CONFLICT',{param:'expected_version'},{retry:'after_refresh'}),undefined,'ORDER_CHANGED_REFRESH_REQUIRED'],
  ['a stale gift card allocation',flintError(409,'VERSION_CONFLICT',{param:'accepted_gift_card_allocation.order_version'},{retry:'after_refresh'}),'payment','ORDER_CHANGED_REFRESH_REQUIRED'],
  ['a stale delivery selection',flintError(409,'VERSION_CONFLICT',{param:'expected_delivery_selection_id'},{retry:'after_refresh'}),'delivery','DELIVERY_SELECTION_CHANGED'],
  ['a stale checkout replacement',flintError(409,'VERSION_CONFLICT',{param:'replace_checkout_session_id'},{retry:'after_refresh'}),undefined,'VERSION_CONFLICT'],
  ['an expired delivery quote',flintError(409,'DELIVERY_REQUOTE_REQUIRED',{reason:'quote_expired'},{retry:'after_refresh'}),'delivery','DELIVERY_QUOTE_EXPIRED'],
  ['a stale delivery quote',flintError(409,'DELIVERY_REQUOTE_REQUIRED',{reason:'quote_stale'},{retry:'after_refresh'}),'delivery','DELIVERY_QUOTE_STALE'],
  ['a changed delivery destination',flintError(409,'DELIVERY_REQUOTE_REQUIRED',{reason:'destination_changed'},{retry:'after_refresh'}),'delivery','DELIVERY_QUOTE_STALE'],
  ['an active payment attempt',flintError(409,'PAYMENT_ATTEMPT_ACTIVE'),'payment','ORDER_PAYMENT_ATTEMPT_ACTIVE'],
  ['a payment still processing',flintError(409,'OPERATION_IN_PROGRESS',{},{retry:'same_request'}),'payment','PAYMENT_ATTEMPT_STILL_PROCESSING'],
  ['gift card value that cannot cover the payment',flintError(409,'LIMIT_EXCEEDED'),'payment','GIFT_CARD_INSUFFICIENT_VALUE'],
  ['a limit outside payment',flintError(409,'LIMIT_EXCEEDED'),undefined,'LIMIT_EXCEEDED'],
  ['an Affirm window that is too short',flintError(409,'PAYMENT_OPTION_UNAVAILABLE',{reason:'action_window_too_short'}),'payment','PAYMENT_ACTION_WINDOW_TOO_SHORT'],
  ['an order whose tax is not ready',flintError(409,'ACTION_NOT_ALLOWED',{reason:'configuration_required',resource_type:'order'}),'payment','ORDER_TAX_NOT_READY'],
  ['the same refusal outside payment',flintError(409,'ACTION_NOT_ALLOWED',{reason:'configuration_required',resource_type:'order'}),undefined,'ACTION_NOT_ALLOWED'],
  ['a payment source that was already used',flintError(409,'ACTION_NOT_ALLOWED',{reason:'terminal_status',resource_type:'confirmation_token'}),'payment','PAYMENT_SOURCE_UNAVAILABLE'],
  ['an attempt that cannot resume',flintError(409,'ACTION_NOT_ALLOWED',{reason:'unsupported_state'}),'payment','PAYMENT_ATTEMPT_NOT_RESUMABLE'],
  ['a closed checkout session',flintError(409,'ACTION_NOT_ALLOWED',{reason:'terminal_status',resource_type:'checkout_session'}),undefined,'CHECKOUT_SESSION_NOT_OPEN'],
  ['a restricted recovery session',flintError(403,'FORBIDDEN',{reason:'checkout_recovery_restricted'}),undefined,'CHECKOUT_RECOVERY_RESTRICTED'],
  ['a checkout that must be paid first',flintError(403,'FORBIDDEN',{reason:'checkout_session_payment_required'}),undefined,'CHECKOUT_SESSION_PAYMENT_REQUIRED'],
  ['a payment leg to choose',flintError(400,'INVALID_REQUEST',{code:'REQUIRED',param:'payment_intents'}),'payment','PAYMENT_LEG_SELECTION_REQUIRED'],
  ['a wrong verification code',flintError(400,'INVALID_REQUEST',{code:'INVALID_VALUE',param:'code'}),'verification','CUSTOMER_VERIFICATION_CODE_INVALID'],
  ['a gift card code that is not valid',flintError(400,'INVALID_REQUEST',{code:'INVALID_VALUE',param:'code'}),undefined,'INVALID_REQUEST'],
  ['an invalid time zone',flintError(400,'INVALID_REQUEST',{code:'INVALID_VALUE',param:'timezone'}),undefined,'INVALID_TIMEZONE'],
  ['an email another customer uses',flintError(409,'ALREADY_EXISTS',{param:'email'}),undefined,'CUSTOMER_EMAIL_ALREADY_USED'],
  ['a saved card code quota',flintError(409,'LIMIT_REACHED',{reason:'saved_card_codes'}),undefined,'PAYMENT_METHOD_SAVE_CODE_LIMIT_REACHED'],
  ['a verification code quota',flintError(409,'LIMIT_REACHED',{reason:'verification_codes'}),undefined,'CUSTOMER_VERIFICATION_RATE_LIMITED'],
  ['verification that is unavailable',flintError(503,'SERVICE_UNAVAILABLE',{},{retry:'same_request'}),'verification','CUSTOMER_VERIFICATION_UNAVAILABLE'],
  ['delivery that is unavailable',flintError(503,'SERVICE_UNAVAILABLE',{},{retry:'same_request'}),'delivery','DELIVERY_SERVICE_UNAVAILABLE'],
  ['a 503 whose outcome is unknown',flintError(503,'SERVICE_UNAVAILABLE',{reason:'outcome_unknown'}),'verification','SERVICE_UNAVAILABLE'],
  ['a gift card challenge',flintError(409,'GIFT_CARD_CHALLENGE_REQUIRED',{reason:'proof_required'}),undefined,'GIFT_CARD_CHALLENGE_REQUIRED'],
];
for(const [label,error,scope,expected] of cases)test(`${label} is named ${expected}`,()=>assert.equal(condition(error,scope as Parameters<typeof condition>[1]),expected));

test('only an ended checkout credential counts as an ended session',()=>{
  assert.equal(sessionEnded(flintError(409,'ACTION_NOT_ALLOWED',{reason:'terminal_status',resource_type:'checkout_session'})),true);
  for(const reason of ['unknown','session_ended'])assert.equal(sessionEnded(flintError(401,'INVALID_CREDENTIAL',{reason})),true);
  assert.equal(sessionEnded(flintError(401,'INVALID_CREDENTIAL',{reason:'expired'})),false);
  assert.equal(sessionEnded(flintError(409,'ACTION_NOT_ALLOWED',{reason:'terminal_status',resource_type:'order'})),false);
  assert.equal(sessionEnded(new Error('local')),false);
});

test('a code the app does not name keeps its public code, and the buyer sees its kind',()=>{
  const error=flintError(409,'RESOURCE_IN_USE');
  assert.deepEqual(appError(error),{kind:'conflict',code:'RESOURCE_IN_USE',message_key:'resource_in_use',request_id:undefined});
});

test('a version conflict reaches the buyer as a changed total',()=>{
  const mapped=appError(flintError(409,'VERSION_CONFLICT',{param:'expected_outstanding_money'},{retry:'after_refresh'}),'payment');
  assert.equal(mapped.code,'ORDER_CHANGED_REFRESH_REQUIRED');assert.equal(mapped.message_key,'total_changed');assert.equal(mapped.kind,'conflict');
});

test('only the work still in progress is an unknown outcome',()=>{
  assert.equal(unknownOutcome(flintError(409,'IDEMPOTENCY_KEY_IN_PROGRESS',{},{retry:'same_request'})),true);
  assert.equal(unknownOutcome(flintError(503,'SERVICE_UNAVAILABLE')),true);
  assert.equal(unknownOutcome(flintError(409,'VERSION_CONFLICT')),false);
});

test('routes read their error scope from the request path',()=>{
  for(const [path,scope] of [['/checkout/chk_a/pay','payment'],['/checkout/chk_a/resume','payment'],['/checkout/chk_a/cancel-attempt','payment'],['/checkout/chk_a/verification','verification'],['/checkout/chk_a/verification/confirm','verification'],['/verify-email/confirm','verification'],['/checkout/chk_a/delivery/quote','delivery'],['/checkout/chk_a/delivery/select','delivery'],['/checkout/chk_a/pickup-locations','delivery'],['/checkout/chk_a/tip',undefined]] as const)assert.equal(scopeOfPath(path),scope,path);
});
