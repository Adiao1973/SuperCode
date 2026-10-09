import { createRoot } from "react-dom/client";
import { InteractionProbe } from "../InteractionProbe";
if (!import.meta.env.DEV) throw new Error("Test probe is development-only");
createRoot(document.getElementById("root")!).render(<InteractionProbe />);
