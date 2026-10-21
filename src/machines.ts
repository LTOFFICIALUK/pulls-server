export type Machine = {
  code: string;
  price: number;
  instantBuyback: number;
  open: boolean;
  listed: boolean;
};

export const pickMachine = (machines: Machine[]) => {
  const open = machines.filter((machine) => machine.open && machine.listed && machine.price > 0);
  open.sort((a, b) => a.price - b.price || b.instantBuyback - a.instantBuyback);
  return open[0] ?? null;
};
