export {
	validateAndGetAccountId,
	validateAndGetBuild,
	validateAndGetPlus,
	validateAndGetRoles,
	validateAndGetVersion,
	generateToken,
	generateStudioBuildValidationToken,
	validateStudioBuildValidationToken,
	studioBuildValidationId,
	generatePhotonAuthToken,
	generateIdentityAssertion,
	validateIdentityAssertion,
	IDENTITY_ASSERTION_TTL_SECONDS,
	TOKEN_TTL_SECONDS,
} from './jwt'
export type { IdentityAssertion, PhotonAuthClaims } from './jwt'
