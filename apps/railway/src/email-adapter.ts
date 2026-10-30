/** The message shape used by auth and accounts' transactional email builders. */
export interface TransactionalEmail {
	from: string | { email: string; name?: string }
	to: string | string[]
	subject: string
	text: string
	html: string
}

/** Railway equivalent of the Workers EMAIL binding, using Resend's HTTP API. */
export class ResendEmail {
	constructor(private readonly apiKey: string | undefined) {}

	async send(message: TransactionalEmail): Promise<void> {
		if (!this.apiKey) throw new Error('Email delivery requires RESEND_API_KEY')
		const response = await fetch('https://api.resend.com/emails', {
			method: 'POST',
			headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
			body: JSON.stringify({
				...message,
				from:
					typeof message.from === 'string'
						? message.from
						: message.from.name
							? `${message.from.name} <${message.from.email}>`
							: message.from.email,
				to: Array.isArray(message.to) ? message.to : [message.to],
			}),
			signal: AbortSignal.timeout(15_000),
		})
		await response.body?.cancel()
		if (!response.ok) throw new Error(`Email delivery failed (HTTP ${response.status})`)
	}
}
