// Control flow: branches, loops, switches, exceptions, and the ternary form.
if (firstCondition && secondCondition && thirdCondition && fourthCondition) {
  handle();
} else if (otherCondition) {
  handleOther();
} else {
  fallback();
}

for (let i = 0; i < items.length; i += 1) {
  process(items[i]);
}

for (const item of collection) {
  consume(item);
}

while (notDone() && attempts < maximumAttempts && !shouldAbort()) {
  attempt();
}

switch (kind) {
  case "a":
    handleA();
    break;
  case "b":
  case "c":
    handleBOrC();
    break;
  default:
    handleDefault();
}

try {
  risky();
} catch (error) {
  recover(error);
} finally {
  cleanup();
}

const choice = enabled ? (pending ? "pending" : "ready") : "disabled";
