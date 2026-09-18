import React from "react";

type LanaWordmarkProps = {
  theme?: "light" | "dark";
  showTagline?: boolean;
  size?: number; // font-size in px for "LANA"; tagline and gaps scale with it
};

const PALETTE = {
  light: { bg: "#F8F6FC", l: "#7C2FD6", text: "#1E1029", tagline: "#8B7FA0" },
  dark:  { bg: "#1A0E2E", l: "#B98CFF", text: "#F8F6FC", tagline: "#A296B8" },
};

export function LanaWordmark({
  theme = "light",
  showTagline = true,
  size = 40,
}: LanaWordmarkProps) {
  const c = PALETTE[theme];
  return (
    <div
      style={{
        display: "inline-flex",
        flexDirection: "column",
        alignItems: "flex-start",
        gap: size * 0.09,
        fontFamily: "'Manrope', system-ui, sans-serif",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          fontSize: size,
          fontWeight: 800,
          letterSpacing: "-0.02em",
          lineHeight: 1,
        }}
      >
        <span style={{ color: c.l }}>L</span>
        <span style={{ color: c.text }}>ANA</span>
      </div>
      {showTagline && (
        <div
          style={{
            fontSize: size * 0.16,
            fontWeight: 600,
            letterSpacing: "0.16em",
            color: c.tagline,
            textTransform: "uppercase",
          }}
        >
          AI Sales Coaching &amp; Scoring
        </div>
      )}
    </div>
  );
}
