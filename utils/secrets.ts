import { ConfigManager } from "@/lib/config";
import { isUuid } from "@/utils/common";
import { Logger } from "@/lib/logger";


/**
 * Generic helper to fetch a secret value.
 * 
 * Precedence:
 * 1. KV Config (Metadata/Pointer) -> Secret Store (Value)
 * 2. Secrets Store (Direct Binding fallback)
 * 3. Environment Variable (Legacy/Local)
 * 
 * CAUTION: This should ONLY be used for operations where the worker is retrieving a secret
 * from the secret-store in order to set the value inside of a GitHub repo, or other external provisioning.
 * 
 * For standard Worker operations (using the key itself), use `env.{SECRET_BINDING_NAME}.get()` directly.
 */
export async function getSecret(env: Env, key: string): Promise<string | undefined> {
    const logger = new Logger(env, 'utils/secrets');

    // 1. Try KV Config (Pointer Pattern)
    try {
        const manager = new ConfigManager(env.KV_CONFIGS);
        const metadata = await manager.getMetadata(key); 

        // CASE A: The key exists in KV and is managed by Secret Store
        if (metadata?.isSecretStoreManaged && metadata.secretName) {
            // We fetch the ACTUAL value from Cloudflare's Secret Store API
            try {
                 const { getSecretsStoreClient } = await import("@/utils/cloudflare/secret-store");
                 const client = await getSecretsStoreClient(env);
                 
                 // We need a store ID. We assume the first available store for now.
                 const store = await client.getDefaultStore();
                 
                 // If we have the ID in metadata.value, use it.
                 // Otherwise, try to find by name.
                 let secretId = String(metadata.value);
                 
                 // If value looks like a UUID, use it. If not (legacy or error), find by name.
                 if (!isUuid(secretId)) {
                     const found = await client.getSecretByName(store.id, metadata.secretName);
                     if (found) secretId = found.id;
                 }
                 
                 if (secretId) {
                    return await client.getSecretValue(store.id, secretId);
                 }
            } catch (apiError: any) {
                logger.warn(`[getSecret] Cloudflare Config Store API check failed for ${key}`, { error: apiError.message });
                // Fallthrough to fallback
            }
        }

        // CASE B: The key exists in KV as a plain string (Non-sensitive config)
        if (metadata?.value && !metadata.isSecretStoreManaged) {
            return String(metadata.value);
        }
        
    } catch (e: any) {
        // KV lookup failed or API failed
        // We log as warning because we have fallbacks
        logger.warn(`[getSecret] KV/API lookup failed for ${key}`, { error: e.message });
    }

    // 2. Fallback: Check Secrets Store or Env Var Binding (Legacy behavior compliance)
    const envVal = (env as any)[key];
    if (envVal && typeof envVal?.get === 'function') {
        const val = await envVal.get();
        // logger.debug(`[getSecret] Retrieved ${key} from direct binding`); // verbose
        return val;
    }
    
    // 3. Fallback: Direct property
    return envVal;
}

export async function getWorkerApiKey(env: Env): Promise<string | undefined> {
    if (env.WORKER_API_KEY) {
        return typeof env.WORKER_API_KEY === 'string' 
            ? env.WORKER_API_KEY 
            : await (env.WORKER_API_KEY as any).get();
    }
    return getSecret(env, "WORKER_API_KEY");
}

/**
 * Helper to fetch the AGENTIC_WORKER_API_KEY from the Secrets Store.
 * This key is exclusively for agent/automation access to the frontend.
 * It supports the ?AGENT_AUTH= URL query param auth path, which is NOT
 * available to the regular WORKER_API_KEY.
 */
export async function getAgenticWorkerApiKey(env: Env): Promise<string | undefined> {
    if (env.AGENTIC_WORKER_API_KEY) {
        return typeof env.AGENTIC_WORKER_API_KEY === 'string'
            ? env.AGENTIC_WORKER_API_KEY
            : await env.AGENTIC_WORKER_API_KEY.get();
    }
    return getSecret(env, "AGENTIC_WORKER_API_KEY");
}

export async function getGithubToken(env: Env): Promise<string | undefined> {
    if (env.GITHUB_TOKEN) {
        return typeof env.GITHUB_TOKEN === 'string'
            ? env.GITHUB_TOKEN
            : await (env.GITHUB_TOKEN as any).get();
    }
    return getSecret(env, "GITHUB_TOKEN");
}

export async function getOpenaiApiKey(env: Env): Promise<string | undefined> {
    if (env.OPENAI_API_KEY) {
        return typeof env.OPENAI_API_KEY === 'string'
            ? env.OPENAI_API_KEY
            : await (env.OPENAI_API_KEY as any).get();
    }
    return getSecret(env, "OPENAI_API_KEY");
}

export async function getAnthropicApiKey(env: Env): Promise<string | undefined> {
    if (env.ANTHROPIC_API_KEY) {
        return typeof env.ANTHROPIC_API_KEY === 'string'
            ? env.ANTHROPIC_API_KEY
            : await (env.ANTHROPIC_API_KEY as any).get();
    }
    return getSecret(env, "ANTHROPIC_API_KEY");
}

export async function getGeminiApiKey(env: Env): Promise<string | undefined> {
    if (env.GEMINI_API_KEY) {
        return typeof env.GEMINI_API_KEY === 'string'
            ? env.GEMINI_API_KEY
            : await (env.GEMINI_API_KEY as any).get();
    }
    return getSecret(env, "GEMINI_API_KEY");
}

export async function getCloudflareApiToken(env: Env): Promise<string | undefined> {
    if (env.CLOUDFLARE_API_TOKEN) {
        return typeof env.CLOUDFLARE_API_TOKEN === 'string'
            ? env.CLOUDFLARE_API_TOKEN
            : await (env.CLOUDFLARE_API_TOKEN as any).get();
    }
    return getSecret(env, "CLOUDFLARE_API_TOKEN");
}

export async function getCloudflareAccountId(env: Env): Promise<string | undefined> {
    if (env.CLOUDFLARE_ACCOUNT_ID) {
        return typeof env.CLOUDFLARE_ACCOUNT_ID === 'string'
            ? env.CLOUDFLARE_ACCOUNT_ID
            : await (env.CLOUDFLARE_ACCOUNT_ID as any).get();
    }
    return getSecret(env, "CLOUDFLARE_ACCOUNT_ID");
}

export async function getGithubClientId(env: Env): Promise<string | undefined> {
    if (env.GITHUB_CLIENT_ID) {
        return typeof env.GITHUB_CLIENT_ID === 'string'
            ? env.GITHUB_CLIENT_ID
            : await (env.GITHUB_CLIENT_ID as any).get();
    }
    return getSecret(env, "GITHUB_CLIENT_ID");
}

export async function getGithubClientSecret(env: Env): Promise<string | undefined> {
    if (env.GITHUB_CLIENT_SECRET) {
        return typeof env.GITHUB_CLIENT_SECRET === 'string'
            ? env.GITHUB_CLIENT_SECRET
            : await (env.GITHUB_CLIENT_SECRET as any).get();
    }
    return getSecret(env, "GITHUB_CLIENT_SECRET");
}

/**
 * Helper to fetch the full GitHub App Private Key.
 * @param env The worker environment bindings
 * @returns The PEM private key string
 */
export async function getGitHubPrivateKey(env: Env): Promise<string> {
    if (env.GITHUB_APP_PRIVATE_KEY) {
        return env.GITHUB_APP_PRIVATE_KEY;
    }

    throw new Error("Missing GITHUB_APP_PRIVATE_KEY in Environment/Secrets Store");
}

/**
 * Helper to fetch the GitHub App ID from secrets store.
 * @param env The worker environment bindings
 */
export async function getGitHubAppId(env: Env): Promise<string> {
    if (env.GITHUB_APP_ID) {
        return typeof env.GITHUB_APP_ID === 'string'
            ? env.GITHUB_APP_ID
            : await (env.GITHUB_APP_ID as any).get();
    }
    
    const appId = await getSecret(env, "GITHUB_APP_ID");
    if (!appId) {
        throw new Error("Missing GITHUB_APP_ID in Secrets Store");
    }
    return appId;
}

/**
 * Helper to fetch the GitHub Webhook Secret.
 * Assuming this is also a Secrets Store binding.
 */
export async function getGitHubWebhookSecret(env: Env): Promise<string> {
    // This often maps to WORKER_API_KEY in this project
    if (env.WORKER_API_KEY) {
        const secret = typeof env.WORKER_API_KEY === 'string' 
            ? env.WORKER_API_KEY 
            : await (env.WORKER_API_KEY as any).get();
        if (secret) return secret;
    }

    const secret = await getSecret(env, "WORKER_API_KEY");
    if (!secret) {
        throw new Error("Missing WORKER_API_KEY in Secrets Store");
    }
    return secret;
}
