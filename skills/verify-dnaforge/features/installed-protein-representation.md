# Installed protein representations

Build the [MolArt package](../../../examples/extensions/molart/) and open the [1TIM coordinates](https://raw.githubusercontent.com/martin-steinegger/molart/712b984b42b51b314badd869155f0d1842e34822/public/samples/1TIM.cif) from a local project in the desktop app.

1. In Advanced settings, choose **View → Cartoon**. Capture the canvas and note the camera orientation.
2. Choose **View → Install protein extension…** and select the built JSON package. The menu should show **MolArt · Klimt**. Check the same orientation, gold ornament on the helices and green pattern on the strands. Rotate the protein and check that the ornament follows the ribbon.
3. Click the styled ribbon. Verify the native focus reports the expected residue, chain and assembly copy. Switch back to Cartoon and apply Klimt again.
4. Close and reopen the coordinate tab, then reload the desktop window. Both actions should restore the local style. While the extension is drawing, check the explanation on Save. Switching back to a built-in view restores portable scene capture.
5. With Klimt active, use **View → Uninstall MolArt · Klimt**. Confirm that the built-in drawing returns and the package disappears from the menu. Reinstall the same file and confirm rendering resumes.
