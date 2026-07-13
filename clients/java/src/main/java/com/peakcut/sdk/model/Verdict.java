package com.peakcut.sdk.model;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonValue;

/**
 * The Critic's verdict on a candidate clip. A clip is only rendered and shipped
 * when it is {@link #KEEP}; {@link #BORDERLINE} moments go back for one refinement
 * round, and {@link #KILL} moments are dropped.
 */
public enum Verdict {

    KEEP("keep"),
    BORDERLINE("borderline"),
    KILL("kill");

    private final String wire;

    Verdict(String wire) {
        this.wire = wire;
    }

    @JsonValue
    public String wireValue() {
        return wire;
    }

    @JsonCreator
    public static Verdict fromWire(String value) {
        if (value != null) {
            for (Verdict verdict : values()) {
                if (verdict.wire.equalsIgnoreCase(value.trim())) {
                    return verdict;
                }
            }
        }
        throw new IllegalArgumentException("Unknown verdict: " + value);
    }
}
