function isCodeClipProviderVerificationSecretRequired(policy = {}) {
  const verificationMode = String(policy.verificationMode || "")
    .trim()
    .toLowerCase();

  return (
    verificationMode === "hmac-sha256" ||
    policy.capabilities?.hmacVerification === true
  );
}

function resolveCodeClipProviderVerificationSecret(policy = {}, env = process.env) {
  if (!isCodeClipProviderVerificationSecretRequired(policy)) {
    return { ok: true, secret: "", required: false };
  }

  const secretEnvName = String(policy.secretEnvName || "").trim();
  const secret = secretEnvName ? String(env?.[secretEnvName] || "").trim() : "";

  if (!secret) {
    return { ok: false, reason: "SECRET_NOT_CONFIGURED", required: true };
  }

  return { ok: true, secret, required: true };
}

module.exports = {
  resolveCodeClipProviderVerificationSecret,
};
