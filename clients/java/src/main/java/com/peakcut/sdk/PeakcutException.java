package com.peakcut.sdk;

/**
 * Base type for every error the SDK raises, so callers can catch a single
 * {@code PeakcutException} for anything that goes wrong talking to the API.
 * Network/serialization problems surface as this type directly; HTTP error
 * responses surface as the {@link ApiException} subclass.
 */
public class PeakcutException extends RuntimeException {

    public PeakcutException(String message) {
        super(message);
    }

    public PeakcutException(String message, Throwable cause) {
        super(message, cause);
    }
}
