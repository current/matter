import Constants from "expo-constants";
import { Observe } from "expo-observe";

const appVariant: unknown = Constants.expoConfig?.extra?.appVariant;

export const crashReportingAvailable = false;

export async function setCrashReportsEnabled(_enabled: boolean) {
  Observe.configure({
    dispatchingEnabled: false,
    ...(typeof appVariant === "string" ? { environment: appVariant } : {}),
  });
}

void setCrashReportsEnabled(false);
