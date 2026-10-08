import test from 'node:test';
import assert from 'node:assert/strict';
import {challengeSpoofMessage} from '../../scenarios/settlement.ts';

test('acceptance spoof payload matches the active session and the completed message shape',()=>{
  const sessionId='cs_ACTIVE_PLACEHOLDER',payload=challengeSpoofMessage(sessionId);
  assert.equal(payload.type,'flint.gift_card_challenge.completed');assert.equal(payload.checkout_session_id,sessionId);
  assert.match(payload.proof,/^[\x21-\x7E]{1,2048}$/);assert.ok(Number.isFinite(Date.parse(payload.expires_at)));assert.ok(Date.parse(payload.expires_at)>Date.now());
  assert.deepEqual(Object.keys(payload).sort(),['checkout_session_id','expires_at','proof','type']);
});
