import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PlaybackOwner } from '../skills/phone-conversation/scripts/playback_binding.js';

describe('phone playback ownership', () => {
	it('allows only the bound call to control playback and releases it by owner', () => {
		const owner = new PlaybackOwner();
		owner.bind('CA-A', '/tmp/sutando-recording-a.mov');
		assert.equal(owner.controlledBy('CA-B'), false);
		assert.equal(owner.controlledBy('CA-A'), true);
		assert.equal(owner.releaseCall('CA-B'), false);
		assert.deepEqual(owner.current(), { callSid: 'CA-A', path: '/tmp/sutando-recording-a.mov' });
		assert.equal(owner.releaseCall('CA-A'), true);
		assert.equal(owner.current(), null);
	});
});
