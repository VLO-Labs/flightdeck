import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tildify } from './paths.ts';

test('the home folder is shown as ~, nothing else changes', () => {
  assert.equal(tildify('/home/vlolabs/dev/vlolabs/flightdeck'), '~/dev/vlolabs/flightdeck');
  assert.equal(tildify('/Users/someone/dev'), '~/dev');
  assert.equal(tildify('/home/vlolabs'), '~');
  assert.equal(tildify('/data/mac-sync/dev/x'), '/data/mac-sync/dev/x');
  assert.equal(tildify('/opt/home/x/y'), '/opt/home/x/y');
});
