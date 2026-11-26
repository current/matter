import type { ProviderInstanceId } from "@t3tools/contracts";
import { useGT } from "gt-react";

import type { ProviderInstanceEntry } from "../../providerInstances";
import { Checkbox } from "../ui/checkbox";

/** Matter: which instances automatic account switching (or delegation) may move work onto. */
export function MatterSwitchableAccounts({
  entries,
  excludedInstanceIds,
  disabled,
  legend,
  onChange,
}: {
  readonly entries: ReadonlyArray<ProviderInstanceEntry>;
  readonly excludedInstanceIds: ReadonlyArray<ProviderInstanceId>;
  readonly disabled: boolean;
  readonly legend?: string;
  readonly onChange: (excludedInstanceIds: ReadonlyArray<ProviderInstanceId>) => void;
}) {
  const gt = useGT();
  const candidates = entries.filter((entry) => entry.enabled);
  if (candidates.length === 0) return null;
  return (
    <fieldset className="mt-2 mb-2 border-l-2 border-border/60 ps-3">
      <legend className="pb-1 text-xs text-muted-foreground">
        {legend ?? gt("Can be switched to")}
      </legend>
      <ul>
        {candidates.map((entry) => (
          <li key={entry.instanceId}>
            <label className="flex cursor-pointer items-center gap-2.5 py-1 text-sm has-data-disabled:cursor-default">
              <Checkbox
                checked={!excludedInstanceIds.includes(entry.instanceId)}
                disabled={disabled}
                onCheckedChange={(switchable) =>
                  onChange(
                    switchable
                      ? excludedInstanceIds.filter((id) => id !== entry.instanceId)
                      : [...excludedInstanceIds, entry.instanceId],
                  )
                }
              />
              <span className="min-w-0 truncate">{entry.displayName}</span>
              <span className="min-w-0 truncate text-xs text-muted-foreground">
                {entry.instanceId}
              </span>
            </label>
          </li>
        ))}
      </ul>
    </fieldset>
  );
}
