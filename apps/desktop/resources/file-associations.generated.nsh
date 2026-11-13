; GENERATED from resources/file-associations.json. Do not edit by hand.
; Run: node scripts/generate-file-association-packaging.cjs

!macro DNAForgeRegisterFileAssociations
  WriteRegStr HKCU "Software\Classes\DNAForge.GenBank" "" "GenBank DNA sequence"
  WriteRegStr HKCU "Software\Classes\DNAForge.GenBank\DefaultIcon" "" '"$INSTDIR\DNAForge.exe",0'
  WriteRegStr HKCU "Software\Classes\DNAForge.GenBank\shell\open\command" "" '"$INSTDIR\DNAForge.exe" "%1"'
  WriteRegStr HKCU "Software\Classes\.gb\OpenWithProgids" "DNAForge.GenBank" ""
  WriteRegStr HKCU "Software\Classes\Applications\DNAForge.exe\SupportedTypes" ".gb" ""
  WriteRegStr HKCU "Software\DNAForge\Capabilities\FileAssociations" ".gb" "DNAForge.GenBank"
  WriteRegStr HKCU "Software\Classes\.gbk\OpenWithProgids" "DNAForge.GenBank" ""
  WriteRegStr HKCU "Software\Classes\Applications\DNAForge.exe\SupportedTypes" ".gbk" ""
  WriteRegStr HKCU "Software\DNAForge\Capabilities\FileAssociations" ".gbk" "DNAForge.GenBank"
  WriteRegStr HKCU "Software\Classes\.gbff\OpenWithProgids" "DNAForge.GenBank" ""
  WriteRegStr HKCU "Software\Classes\Applications\DNAForge.exe\SupportedTypes" ".gbff" ""
  WriteRegStr HKCU "Software\DNAForge\Capabilities\FileAssociations" ".gbff" "DNAForge.GenBank"
  WriteRegStr HKCU "Software\Classes\.genbank\OpenWithProgids" "DNAForge.GenBank" ""
  WriteRegStr HKCU "Software\Classes\Applications\DNAForge.exe\SupportedTypes" ".genbank" ""
  WriteRegStr HKCU "Software\DNAForge\Capabilities\FileAssociations" ".genbank" "DNAForge.GenBank"
  WriteRegStr HKCU "Software\Classes\DNAForge.SnapGene" "" "SnapGene DNA document"
  WriteRegStr HKCU "Software\Classes\DNAForge.SnapGene\DefaultIcon" "" '"$INSTDIR\DNAForge.exe",0'
  WriteRegStr HKCU "Software\Classes\DNAForge.SnapGene\shell\open\command" "" '"$INSTDIR\DNAForge.exe" "%1"'
  WriteRegStr HKCU "Software\Classes\.dna\OpenWithProgids" "DNAForge.SnapGene" ""
  WriteRegStr HKCU "Software\Classes\Applications\DNAForge.exe\SupportedTypes" ".dna" ""
  WriteRegStr HKCU "Software\DNAForge\Capabilities\FileAssociations" ".dna" "DNAForge.SnapGene"
  WriteRegStr HKCU "Software\DNAForge\Capabilities" "ApplicationName" "DNAForge"
  WriteRegStr HKCU "Software\DNAForge\Capabilities" "ApplicationDescription" "Design and inspect biological sequences"
  WriteRegStr HKCU "Software\RegisteredApplications" "DNAForge" "Software\DNAForge\Capabilities"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro DNAForgeUnregisterFileAssociations
  DeleteRegValue HKCU "Software\Classes\.gb\OpenWithProgids" "DNAForge.GenBank"
  DeleteRegValue HKCU "Software\Classes\Applications\DNAForge.exe\SupportedTypes" ".gb"
  DeleteRegValue HKCU "Software\DNAForge\Capabilities\FileAssociations" ".gb"
  DeleteRegValue HKCU "Software\Classes\.gbk\OpenWithProgids" "DNAForge.GenBank"
  DeleteRegValue HKCU "Software\Classes\Applications\DNAForge.exe\SupportedTypes" ".gbk"
  DeleteRegValue HKCU "Software\DNAForge\Capabilities\FileAssociations" ".gbk"
  DeleteRegValue HKCU "Software\Classes\.gbff\OpenWithProgids" "DNAForge.GenBank"
  DeleteRegValue HKCU "Software\Classes\Applications\DNAForge.exe\SupportedTypes" ".gbff"
  DeleteRegValue HKCU "Software\DNAForge\Capabilities\FileAssociations" ".gbff"
  DeleteRegValue HKCU "Software\Classes\.genbank\OpenWithProgids" "DNAForge.GenBank"
  DeleteRegValue HKCU "Software\Classes\Applications\DNAForge.exe\SupportedTypes" ".genbank"
  DeleteRegValue HKCU "Software\DNAForge\Capabilities\FileAssociations" ".genbank"
  DeleteRegKey HKCU "Software\Classes\DNAForge.GenBank"
  DeleteRegValue HKCU "Software\Classes\.dna\OpenWithProgids" "DNAForge.SnapGene"
  DeleteRegValue HKCU "Software\Classes\Applications\DNAForge.exe\SupportedTypes" ".dna"
  DeleteRegValue HKCU "Software\DNAForge\Capabilities\FileAssociations" ".dna"
  DeleteRegKey HKCU "Software\Classes\DNAForge.SnapGene"
  DeleteRegValue HKCU "Software\RegisteredApplications" "DNAForge"
  DeleteRegValue HKCU "Software\DNAForge\Capabilities" "ApplicationName"
  DeleteRegValue HKCU "Software\DNAForge\Capabilities" "ApplicationDescription"
  DeleteRegKey /ifempty HKCU "Software\Classes\Applications\DNAForge.exe\SupportedTypes"
  DeleteRegKey /ifempty HKCU "Software\Classes\Applications\DNAForge.exe"
  DeleteRegKey /ifempty HKCU "Software\DNAForge\Capabilities\FileAssociations"
  DeleteRegKey /ifempty HKCU "Software\DNAForge\Capabilities"
  DeleteRegKey /ifempty HKCU "Software\DNAForge"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
