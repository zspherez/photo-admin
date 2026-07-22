"use client";

import { useEffect } from "react";

export function PwaRegistration() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const developmentTestEnabled =
      process.env.NEXT_PUBLIC_ENABLE_PWA_TEST === "true";
    if (process.env.NODE_ENV !== "production" && !developmentTestEnabled) {
      void navigator.serviceWorker
        .getRegistration("/")
        .then((registration) => registration?.unregister())
        .catch((error) => {
          console.error("Unable to remove the development service worker", error);
        });
      return;
    }
    if (
      window.location.protocol !== "https:" &&
      window.location.hostname !== "localhost"
    ) {
      return;
    }

    const register = async () => {
      try {
        const registration = await navigator.serviceWorker.register("/sw.js", {
          scope: "/",
          updateViaCache: "none",
        });
        await registration.update();
      } catch (error) {
        console.error("Unable to register the offline shell", error);
      }
    };

    if (document.readyState === "complete") {
      void register();
      return;
    }

    window.addEventListener("load", register, { once: true });
    return () => window.removeEventListener("load", register);
  }, []);

  return null;
}
