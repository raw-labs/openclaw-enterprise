#set document(title: [$title$], author: "Miguel Branco")
#set page(
  paper: "a4",
  margin: (left: 18mm, right: 18mm, top: 21mm, bottom: 20mm),
  header: align(right, text(size: 8pt, fill: rgb("#54647a"))[PROPOSAL · NOT IMPLEMENTED]),
  footer: context align(center, text(size: 8pt, fill: rgb("#667085"))[Gateway outbound control · #counter(page).display("1")]),
)
#set text(font: "Libertinus Serif", size: 10pt, fill: rgb("#25364a"))
#set par(justify: false, leading: 0.55em, spacing: 0.75em)
#set heading(numbering: "1.1")
#show heading.where(level: 1): set text(size: 18pt, weight: "bold", fill: rgb("#204d65"))
#show heading.where(level: 2): set text(size: 12pt, weight: "bold")
#show link: set text(fill: rgb("#17618a"))
#show raw: set text(font: "DejaVu Sans Mono", size: 7.5pt)
#show raw.where(block: true): it => block(fill: rgb("#f3f5f7"), inset: 7pt, radius: 3pt, breakable: false, it)
#set table(inset: 5pt, stroke: (bottom: 0.4pt + rgb("#d6dde5")), align: left + top)
#show figure.where(kind: table): set figure.caption(position: top)
#show figure.where(kind: table): set block(breakable: true)
#show figure.where(kind: image): set figure.caption(position: bottom)
#align(center)[
  #v(12mm)
  #text(size: 26pt, weight: "bold", fill: rgb("#204d65"))[$title$]
  #v(5mm)
  #text(size: 13pt)[$subtitle$]
  #v(5mm)
  #text(size: 11pt)[Miguel Branco · 28 October 2026]
  #v(7mm)
  #block(fill: rgb("#edf2f7"), inset: 10pt, width: 100%)[
    #text(weight: "bold")[Destination authorization only]
    #linebreak()
    Native credentials and end-to-end TLS remain unchanged. This RFC adds no runtime implementation.
  ]
]
#v(6mm)
#outline(depth: 2, title: [Contents])
#pagebreak()
$body$
