import {test} from 'node:test';
import assert from 'node:assert/strict';
import {intervalUnit} from '../../src/copy.ts';

test('billing interval units follow the public billing_interval values and pluralize by count',()=>{
  const expected={daily:'day',weekly:'week',monthly:'month',yearly:'year'};
  for(const [interval,unit] of Object.entries(expected)){
    assert.equal(intervalUnit(interval,1),unit);assert.equal(intervalUnit(interval,2),`${unit}s`);
    assert.equal(intervalUnit(unit,1),unit,'the singular alias still works');assert.equal(intervalUnit(unit,3),`${unit}s`);
  }
});
