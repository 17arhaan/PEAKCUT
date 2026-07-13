package com.peakcut.sdk.http;

import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.json.JsonMapper.Builder;
import com.peakcut.sdk.PeakcutException;

/**
 * A thin, forgiving JSON facade over Jackson, shared by the transport. Unknown
 * fields are ignored (so the SDK keeps working when the API adds fields), and any
 * (de)serialization failure is rethrown as a {@link PeakcutException} so callers
 * only ever have to catch the SDK's own exception type.
 */
public final class JsonMapper {

    private final ObjectMapper mapper;

    public JsonMapper() {
        this.mapper = com.fasterxml.jackson.databind.json.JsonMapper.builder()
                .configure(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES, false)
                .configure(DeserializationFeature.ACCEPT_SINGLE_VALUE_AS_ARRAY, true)
                .build();
    }

    /** Serialize a value to a JSON string. */
    public String write(Object value) {
        try {
            return mapper.writeValueAsString(value);
        } catch (Exception e) {
            throw new PeakcutException("Failed to serialize request body", e);
        }
    }

    /** Deserialize a JSON string into {@code type}. */
    public <T> T read(String json, Class<T> type) {
        try {
            return mapper.readValue(json, type);
        } catch (Exception e) {
            throw new PeakcutException("Failed to parse response as " + type.getSimpleName(), e);
        }
    }

    /** Access the underlying mapper for advanced use (generic types, trees). */
    public ObjectMapper raw() {
        return mapper;
    }

    /** Hook for tests/customization that need a preconfigured builder. */
    static Builder defaults() {
        return com.fasterxml.jackson.databind.json.JsonMapper.builder()
                .configure(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES, false);
    }
}
