import {test} from 'node:test';
import assert from 'node:assert/strict';

import {projectClientAction} from '../../src/flint/projection.ts';
import type {PendingPaymentAction} from '@flintpay/node';

const expiresAt='2099-01-01T00:00:00Z';
const stripeAction={account_id:'acct_example',publishable_key:'pk_test_example',payment_intent:{client_secret:'pi_example_secret_example',stripe_js_call:'handle_next_action'}};
test('server projects URL and Stripe actions by type with the pending action expiry',()=>{
  const pending=(client_action:unknown)=>({pending_action_id:'action_example',expires_at:expiresAt,client_action} as PendingPaymentAction);
  assert.deepEqual(projectClientAction(pending({type:'url',url:'https://payment-return.example.invalid/action/example',stripe:stripeAction})),{type:'url',url:'https://payment-return.example.invalid/action/example',expiresAt});
  assert.deepEqual(projectClientAction(pending({type:'stripe',stripe:stripeAction})),{type:'stripe',stripe:stripeAction,expiresAt});
  assert.equal(projectClientAction(pending({type:'future',stripe:stripeAction})),undefined);
  assert.equal(projectClientAction(undefined),undefined);
});
