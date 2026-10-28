function Table(table)
  local first = pandoc.utils.stringify(table.head.rows[1].cells[1])
  local widths = { 0.36, 0.64 }
  if #table.colspecs == 3 then
    widths = { 0.18, 0.41, 0.41 }
  elseif first == "Selection" then
    widths = { 0.22, 0.78 }
  elseif first == "Required case" then
    widths = { 0.30, 0.70 }
  elseif first == "Source" then
    widths = { 0.40, 0.60 }
  end
  for index, width in ipairs(widths) do
    table.colspecs[index] = { pandoc.AlignLeft, width }
  end
  return table
end
