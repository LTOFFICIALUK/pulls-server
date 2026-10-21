export const resolve = async (specifier, context, nextResolve) => {
  if (specifier === "@coral-xyz/anchor") {
    return {
      format: "module",
      shortCircuit: true,
      url: new URL("./anchor-shim.mjs", import.meta.url).href,
    };
  }
  return nextResolve(specifier, context);
};
