import { useMemo } from "react";
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid } from "recharts";
import { Token } from "@workspace/api-client-react";
import { ethers } from "ethers";

export function BondingCurveChart({ token }: { token: Token }) {
  const data = useMemo(() => {
    try {
      const vt = parseFloat(ethers.formatEther(token.virtualTokenReserves || "0"));
      const ve = parseFloat(ethers.formatEther(token.virtualEthReserves || "0"));
      const supply = parseFloat(ethers.formatEther(token.totalSupply || "0"));
      
      if (vt === 0 || ve === 0 || supply === 0) return [];

      const k = ve * vt;
      const points = [];
      const steps = 20;
      
      // Plot from 0 to 80% of total supply
      const maxSold = supply * 0.8;
      
      for (let i = 0; i <= steps; i++) {
        const percent = i / steps;
        const x = maxSold * percent;
        // Price formula: V_e * V_t / (V_t - x)^2
        const denominator = Math.pow((vt - x), 2);
        let price = 0;
        if (denominator > 0) {
          price = k / denominator;
        }
        
        points.push({
          percentSold: (percent * 80).toFixed(0) + "%",
          price: price,
        });
      }
      return points;
    } catch (e) {
      console.error(e);
      return [];
    }
  }, [token]);

  if (!data || data.length === 0) {
    return <div className="h-full w-full flex items-center justify-center text-muted-foreground">No chart data</div>;
  }

  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={data} margin={{ top: 5, right: 5, left: 5, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#222" vertical={false} />
        <XAxis 
          dataKey="percentSold" 
          stroke="#555" 
          fontSize={12} 
          tickLine={false} 
          axisLine={false}
          dy={10}
        />
        <YAxis 
          stroke="#555" 
          fontSize={12} 
          tickLine={false} 
          axisLine={false} 
          tickFormatter={(val) => val.toFixed(6)}
          domain={['auto', 'auto']}
          dx={-10}
        />
        <Tooltip 
          contentStyle={{ backgroundColor: 'hsl(var(--card))', borderColor: 'hsl(var(--border))', borderRadius: '8px' }}
          itemStyle={{ color: 'hsl(var(--primary))' }}
          formatter={(value: number) => [value.toFixed(8) + ' ETH', 'Price']}
          labelStyle={{ color: 'hsl(var(--muted-foreground))' }}
        />
        <Line 
          type="monotone" 
          dataKey="price" 
          stroke="hsl(var(--primary))" 
          strokeWidth={2} 
          dot={false}
          activeDot={{ r: 4, fill: 'hsl(var(--primary))', stroke: '#fff' }}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
