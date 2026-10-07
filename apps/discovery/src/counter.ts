import { parseEnvelope, parseFields, parseTokenSuffix } from './ai-request'

import type { App } from './context'

type Env = App['Bindings']
type CounterName = 'CounterAdd' | 'CounterGet'

const ANTICACHE_FIELDS = new Set(['Anticache'])

/** Accept the original no-argument command and the CV2 cache-busting form. */
export function counterToken(command: string, name: CounterName): string | null {
	const suffix = command.slice(name.length)
	if (!suffix.startsWith('[')) return parseTokenSuffix(suffix)
	const envelope = parseEnvelope(command, `${name}[`)
	if (!envelope) return null
	const fields = parseFields(envelope.body, ANTICACHE_FIELDS)
	return fields && Object.hasOwn(fields, 'Anticache') ? envelope.token : null
}

/** A page-source section whose readable text is the current counter value. */
export function counterResponse(value: number) {
	const text = String(value)
	return [
		{
			id: text,
			sectionType: 13,
			sectionSubType: 'CounterResponse',
			source: 'PageSource',
			sourceMetadata: text,
			displayMetadata: JSON.stringify({ DisplayTitle: text }),
		},
	]
}

/** The update and its returned value are one SQL statement, so concurrent adds cannot lose increments. */
export async function counterAdd(env: Env): Promise<number> {
	const value = await env.DB.prepare(
		'UPDATE cv2_counter SET value = value + 1 WHERE id = 1 RETURNING value'
	).first<number>('value')
	if (value === null) throw new Error('CV2 counter row is missing')
	return value
}

export async function counterGet(env: Env): Promise<number> {
	const value = await env.DB.prepare('SELECT value FROM cv2_counter WHERE id = 1').first<number>(
		'value'
	)
	if (value === null) throw new Error('CV2 counter row is missing')
	return value
}
