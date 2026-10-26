import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

export function twilioSignature(authToken: string, url: string, params: URLSearchParams): string {
	let signed = url;
	for (const key of [...new Set(params.keys())].sort()) {
		for (const value of params.getAll(key).sort()) signed += key + value;
	}
	return createHmac('sha1', authToken).update(signed).digest('base64');
}

export function isValidTwilioSignature(
	authToken: string,
	signature: string | undefined,
	url: string,
	params: URLSearchParams,
): boolean {
	if (!authToken || !signature || !url) return false;
	const expected = Buffer.from(twilioSignature(authToken, url, params));
	const actual = Buffer.from(signature);
	return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function mediaStreamUrl(webhookBase: string): string {
	return `wss://${new URL(webhookBase).host}/media-stream`;
}

export function isValidMediaStreamUpgrade(
	authToken: string,
	headers: IncomingHttpHeaders,
	webhookBase: string,
): boolean {
	if (!webhookBase) return false;
	let wsUrl: string;
	try {
		wsUrl = mediaStreamUrl(webhookBase);
	} catch {
		return false;
	}
	const signature = headers['x-twilio-signature'];
	if (typeof signature !== 'string') return false;
	const httpsUrl = wsUrl.replace(/^wss:/, 'https:');
	const params = new URLSearchParams();
	return isValidTwilioSignature(authToken, signature, wsUrl, params)
		|| isValidTwilioSignature(authToken, signature, httpsUrl, params);
}
