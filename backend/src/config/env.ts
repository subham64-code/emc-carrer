import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";

const envCandidates = [
  path.resolve(process.cwd(), ".env"),
  path.resolve(process.cwd(), "../.env"),
  path.resolve(__dirname, "../../.env"),
];
for (const candidate of envCandidates) {
  if (fs.existsSync(candidate)) {
    dotenv.config({ path: candidate });
    break;
  }
}

function str(key: string, fallback = ""): string {
  const value = process.env[key];
  return value === undefined || value === "" ? fallback : value;
}

function num(key: string, fallback: number): number {
  const value = Number(process.env[key]);
  return Number.isFinite(value) ? value : fallback;
}

function bool(key: string, fallback = false): boolean {
  const value = process.env[key];
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

const nodeEnv = str("NODE_ENV", "development");
const isProd = nodeEnv === "production";

const aiWeights = {
  skills: num("AI_WEIGHT_SKILLS", 35),
  experience: num("AI_WEIGHT_EXPERIENCE", 25),
  qualification: num("AI_WEIGHT_QUALIFICATION", 15),
  domain: num("AI_WEIGHT_DOMAIN", 15),
  certification: num("AI_WEIGHT_CERTIFICATION", 10),
};

const weightTotal = Object.values(aiWeights).reduce((a, b) => a + b, 0);

export const env = {
  nodeEnv,
  isProd,
  isDev: !isProd,
  port: num("PORT", 4000),
  appName: str("APP_NAME", "EMC Talent Acquisition Portal"),
  appUrl: str("APP_URL", "http://localhost:5173"),
  careerSiteUrl: str("CAREER_SITE_URL", "http://localhost:5000/careers.html"),
  trackApplicationUrl: str("TRACK_APPLICATION_URL", "http://localhost:5000/track-application.html"),
  apiUrl: str("API_URL", "http://localhost:4000"),
  publicApiUrl: str("PUBLIC_API_URL", "http://localhost:4000"),
  employeeUpdateUrl: str("EMPLOYEE_UPDATE_URL", `${isProd ? "https://emc-hr-frontend.pages.dev" : "http://localhost:5173"}/employee/update`),
  docUploadUrl: str("DOC_UPLOAD_URL", `${isProd ? "https://emc-hr-frontend.pages.dev" : "http://localhost:5173"}/onboard/documents`),
  offerRespondUrl: str("OFFER_RESPOND_URL", `${isProd ? "https://emc-hr-frontend.pages.dev" : "http://localhost:5173"}/offer/respond`),
  corsOrigins: str("CORS_ORIGINS", "http://localhost:5173,http://localhost:5000")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
  defaultTimezone: str("DEFAULT_TIMEZONE", "Asia/Kolkata"),

  databaseUrl: str("DATABASE_URL", ""),
  // auto (probe tcp -> ws -> http), tcp, ws or http. See lib/prisma.ts.
  dbTransport: str("DB_TRANSPORT", "auto").toLowerCase(),

  jwtSecret: str(
    "JWT_SECRET",
    isProd ? "" : "emc-dev-only-secret-change-me-please-0123456789abcdef",
  ),
  jwtExpiresIn: str("JWT_EXPIRES_IN", "12h"),

  // TOTP (RFC 6238) — HR roles sign in with email + authenticator code.
  // AES-256-GCM key used to encrypt TOTP secrets at rest (base64, 32 bytes).
  totpEncryptionKey: str("TOTP_ENCRYPTION_KEY", ""),
  totpIssuer: str("TOTP_ISSUER", "Ecometrix"),
  totpWindowSeconds: num("TOTP_WINDOW_SECONDS", 30),
  totpEnrollmentTtlMinutes: num("TOTP_ENROLLMENT_TTL_MINUTES", 10),
  totpMaxAttempts: num("TOTP_MAX_ATTEMPTS", 5),
  totpLockoutMinutes: num("TOTP_LOCKOUT_MINUTES", 15),

  otpTtlMinutes: num("OTP_TTL_MINUTES", 5),
  otpMaxAttempts: num("OTP_MAX_ATTEMPTS", 5),
  otpResendCooldownSeconds: num("OTP_RESEND_COOLDOWN_SECONDS", 60),
  employeeInviteTtlHours: num("EMPLOYEE_INVITE_TTL_HOURS", 72),
  sessionTtlHours: num("SESSION_TTL_HOURS", 12),

  seedSuperAdminEmail: str("SEED_SUPER_ADMIN_EMAIL", "hr.admin@emc.example"),
  seedSuperAdminName: str("SEED_SUPER_ADMIN_NAME", "HR Department"),
  seedItAdminEmail: str("SEED_IT_ADMIN_EMAIL", "it.admin@emc.example"),
  seedItAdminPassword: str("SEED_IT_ADMIN_PASSWORD", isProd ? "" : "it-admin-dev-password-change-me"),

  storageProvider: str("STORAGE_PROVIDER", "local"),
  localStorageDir: path.resolve(process.cwd(), str("LOCAL_STORAGE_DIR", "./storage/uploads")),
  maxUploadMb: num("MAX_UPLOAD_MB", 10),

  smtpHost: str("SMTP_HOST", ""),
  smtpPort: num("SMTP_PORT", 587),
  smtpSecure: bool("SMTP_SECURE", false),
  smtpRejectUnauthorized: bool("SMTP_REJECT_UNAUTHORIZED", true),
  smtpUser: str("SMTP_USER", ""),
  smtpPass: str("SMTP_PASS", ""),
  resendApiKey: str("RESEND_API_KEY", ""),
  brevoApiKey: str("BREVO_API_KEY", str("SMTP_PASS", "")),
  mailFrom: str("MAIL_FROM", "EMC Talent Acquisition <no-reply@emc.example>"),
  mailReplyTo: str("MAIL_REPLY_TO", "hr@emc.example"),

  aiWeights,
  aiWeightsValid: weightTotal === 100,
  aiScoringVersion: str("AI_SCORING_VERSION", "v1"),
  ocrEnabled: bool("OCR_ENABLED", true),
  ocrLanguages: str("OCR_LANGUAGES", "eng"),
  aiTopRecommendations: num("AI_TOP_RECOMMENDATIONS", 10),

  // In-process cache for hot-path reads (dashboard, career listings, reports).
  cacheTtlSeconds: num("CACHE_TTL_SECONDS", 60),
  cacheEnabled: bool("CACHE_ENABLED", true),
  // Short-TTL cache for resolved auth contexts (session + user lookup over Neon).
  authCacheTtlSeconds: num("AUTH_CACHE_TTL_SECONDS", 30),
  authCacheEnabled: bool("AUTH_CACHE_ENABLED", true),

  // File storage. Production must use a cloud bucket (google_drive | s3).
  storageAllowLocal: bool("STORAGE_ALLOW_LOCAL", false),
  s3Endpoint: str("S3_ENDPOINT", str("FILEBASE_ENDPOINT", "")),
  s3Region: str("S3_REGION", str("REGION", "auto")),
  s3Bucket: str("S3_BUCKET", str("FILEBASE_BUCKET", "")),
  s3AccessKeyId: str("S3_ACCESS_KEY_ID", str("FILEBASE_ACCESS_KEY_ID", "")),
  s3SecretAccessKey: str("S3_SECRET_ACCESS_KEY", str("FILEBASE_SECRET_ACCESS_KEY", "")),
  s3ForcePathStyle: bool("S3_FORCE_PATH_STYLE", true),

  rateLimitWindowMinutes: num("RATE_LIMIT_WINDOW_MINUTES", 15),
  rateLimitMax: num("RATE_LIMIT_MAX", 300),
  authRateLimitMax: num("AUTH_RATE_LIMIT_MAX", 20),
};

export const smtpConfigured = Boolean(env.smtpHost && env.smtpUser && env.smtpPass);
export const resendConfigured = Boolean(env.resendApiKey);
export const brevoConfigured = Boolean(env.brevoApiKey && (env.smtpHost.includes("brevo") || env.brevoApiKey.startsWith("xsmtpsib") || env.brevoApiKey.startsWith("xkeysib")));

if (isProd) {
  if (!env.jwtSecret || env.jwtSecret.includes("change-me")) {
    throw new Error("JWT_SECRET must be configured with a strong secret in production.");
  }
  if (!env.databaseUrl) {
    throw new Error("DATABASE_URL is required.");
  }
  if (!env.totpEncryptionKey) {
    throw new Error("TOTP_ENCRYPTION_KEY is required (base64-encoded 32-byte key).");
  }
  if (!env.aiWeightsValid) {
    throw new Error("AI weight configuration must total 100.");
  }
  if (env.corsOrigins.some((origin) => origin === "*" || /localhost|127\.0\.0\.1/.test(origin))) {
    throw new Error("CORS_ORIGINS must contain deployed HTTPS origins only.");
  }
  if ([env.appUrl, env.apiUrl, env.careerSiteUrl, env.trackApplicationUrl].some((url) => /localhost|127\.0\.0\.1/.test(url))) {
    throw new Error("APP_URL, API_URL, CAREER_SITE_URL and TRACK_APPLICATION_URL must use deployed URLs.");
  }
  if (env.storageProvider === "s3" && !env.storageAllowLocal && (!env.s3Bucket || !env.s3AccessKeyId || !env.s3SecretAccessKey)) {
    throw new Error("S3 bucket and credentials are required in production when STORAGE_PROVIDER=s3.");
  }
}
