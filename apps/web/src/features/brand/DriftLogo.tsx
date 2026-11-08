import Image from "next/image";
import styles from "./brand.module.css";

/** The supplied Drift artwork, shared by the welcome, sky and export surfaces. */
export function DriftLogo({ variant = "compact", preload = false }: {
  variant?: "welcome" | "compact" | "small";
  preload?: boolean;
}) {
  return <Image
    src="/brand/drift-logo.png"
    alt="Drift"
    width={1600}
    height={1120}
    sizes={variant === "welcome" ? "224px" : variant === "small" ? "64px" : "88px"}
    preload={preload}
    className={`${styles.logo} ${styles[variant]}`}
  />;
}
