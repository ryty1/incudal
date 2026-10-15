export function getStrictTurnstilePrecheck(config: {
    enabled: boolean
    secretKey: string | null
}, token?: string): {
    ok: true
    skip: true
} | {
    ok: true
    skip: false
    secretKey: string
    token: string
} | {
    ok: false
    statusCode: number
    payload: { error: string; code: string }
} {
    if (!config.enabled) {
        return { ok: true, skip: true }
    }

    if (!config.secretKey) {
        return {
            ok: false,
            statusCode: 503,
            payload: {
                error: 'Turnstile verification is not configured',
                code: 'TURNSTILE_NOT_CONFIGURED'
            }
        }
    }

    if (!token) {
        return {
            ok: false,
            statusCode: 400,
            payload: {
                error: 'Turnstile verification required',
                code: 'TURNSTILE_TOKEN_MISSING'
            }
        }
    }

    return {
        ok: true,
        skip: false,
        secretKey: config.secretKey,
        token
    }
}
