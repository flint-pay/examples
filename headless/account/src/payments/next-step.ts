import type {OrderPaymentAttempt} from '@flintpay/node';
export type NextStep='done'|'pay_remaining'|'new_payment'|'capture'|'authenticate'|'resume'|'wait'|'bank_processing';
export function nextStep(attempt:OrderPaymentAttempt|undefined,options:Map<string,string>=new Map()):NextStep {
  if(!attempt)return 'new_payment';
  if(attempt.status==='succeeded')return 'done';
  if(attempt.status==='partially_succeeded')return 'pay_remaining';
  if(['failed','canceled','expired'].includes(attempt.status))return 'new_payment';
  if(attempt.status==='requires_capture')return 'capture';
  if(attempt.status==='requires_action')return 'authenticate';
  if(attempt.status==='processing'&&!attempt.is_resumable&&attempt.payment_intents?.some(leg=>options.get(leg.payment_intent_id)==='ach_debit'))return 'bank_processing';
  return attempt.is_resumable?'resume':'wait';
}
export function attemptOpen(attempt:OrderPaymentAttempt|undefined):boolean{return !!attempt&&!['succeeded','partially_succeeded','failed','canceled','expired'].includes(attempt.status);}
