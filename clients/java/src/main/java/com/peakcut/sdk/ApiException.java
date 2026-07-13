package com.peakcut.sdk;

/**
 * Thrown when the API returns a non-2xx response. Carries the HTTP status and the
 * raw response body so callers can distinguish, for example, a {@code 402} (out of
 * minutes) from a {@code 404} (job not found) or a {@code 401} (bad/no auth).
 */
public class ApiException extends PeakcutException {

    private final int status;
    private final String body;

    public ApiException(int status, String body) {
        super("Peakcut API returned HTTP " + status
                + (body == null || body.isBlank() ? "" : ": " + truncate(body)));
        this.status = status;
        this.body = body == null ? "" : body;
    }

    /** The HTTP status code of the failing response. */
    public int status() {
        return status;
    }

    /** The raw response body (possibly a JSON error object), never null. */
    public String body() {
        return body;
    }

    /** True for 401/403 — authentication or authorization failed. */
    public boolean isAuthError() {
        return status == 401 || status == 403;
    }

    /** True for 402 — the account is out of processing minutes. */
    public boolean isOutOfCredits() {
        return status == 402;
    }

    /** True for 404 — the job/resource does not exist (or isn't yours). */
    public boolean isNotFound() {
        return status == 404;
    }

    /** True for 429 and 5xx — worth retrying after a backoff. */
    public boolean isRetryable() {
        return status == 429 || (status >= 500 && status < 600);
    }

    private static String truncate(String s) {
        return s.length() <= 300 ? s : s.substring(0, 300) + "…";
    }
}
