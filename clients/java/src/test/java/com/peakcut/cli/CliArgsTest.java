package com.peakcut.cli;

import com.peakcut.sdk.PeakcutException;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** Tests the CLI's little argument parser: options, bare flags, positionals,
 *  defaults, and required-value errors. */
class CliArgsTest {

    @Test
    void parsesOptionsFlagsAndPositionals() {
        PeakcutCli.Args a = PeakcutCli.Args.parse(
                new String[] {"submit", "--url", "https://x", "--watch", "job_123"}, 1);

        assertEquals("https://x", a.require("url"));
        assertTrue(a.flag("watch"));
        assertEquals("job_123", a.positionalOrThrow("jobId"));
    }

    @Test
    void bareFlagBeforeAnotherOptionIsTreatedAsBoolean() {
        PeakcutCli.Args a = PeakcutCli.Args.parse(
                new String[] {"x", "--watch", "--out", "clips"}, 1);
        assertTrue(a.flag("watch"));
        assertEquals("clips", a.require("out"));
    }

    @Test
    void getIntUsesDefaultWhenAbsent() {
        PeakcutCli.Args a = PeakcutCli.Args.parse(new String[] {"x"}, 1);
        assertEquals(2, a.getInt("interval", 2));

        PeakcutCli.Args b = PeakcutCli.Args.parse(new String[] {"x", "--interval", "5"}, 1);
        assertEquals(5, b.getInt("interval", 2));
    }

    @Test
    void requireAndPositionalThrowWhenMissing() {
        PeakcutCli.Args a = PeakcutCli.Args.parse(new String[] {"status"}, 1);
        assertThrows(PeakcutException.class, () -> a.require("url"));
        assertThrows(PeakcutException.class, () -> a.positionalOrThrow("jobId"));
        assertFalse(a.has("url"));
        assertEquals("fallback", a.getOrDefault("missing", "fallback"));
    }
}
