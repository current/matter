import type { MattrTaskStatus } from "@t3tools/contracts";
import { useGT } from "gt-react";

export function useTaskStatusLabel() {
  const gt = useGT();
  return (status: MattrTaskStatus) => {
    switch (status) {
      case "todo":
        return gt("To Do", { $context: "task board column" });
      case "in_progress":
        return gt("In Progress", { $context: "task board column" });
      case "in_review":
        return gt("In Review", { $context: "task board column" });
      case "done":
        return gt("Done", { $context: "task board column" });
    }
  };
}
