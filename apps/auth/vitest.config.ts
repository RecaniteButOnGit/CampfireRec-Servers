import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: `${__dirname}/wrangler.jsonc` },
			miniflare: {
				bindings: {
					ENVIRONMENT: 'VITEST',
					// Most auth cases exercise RecFlare's 2023, 2025 and 2026 protocols; the
					// rollout suite overrides these to check gate behavior explicitly.
					SUPPORTED_GAME_VERSIONS: '20230414,20240621,20250718,20260323',
					ROLLOUT_GAME_VERSIONS: '20260323',
					// Password (no-platform) signup is OFF by default, and most create_account tests
					// post no `platform` — they'd all test the closed door. The switch itself is
					// covered by a test that flips it off and back.
					PASSWORD_SIGNUP: 'on',
				},
			},
		}),
	],
})
