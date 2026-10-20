//! Extraction du texte, page par page.
//!
//! - PDF : une page = une page du PDF (`pdf-extract`).
//! - PowerPoint (.pptx) : une page = une diapositive, dans l'ordre des numéros de diapo.
//! - Word (.docx) : pas de pagination dans le fichier ; une page = un bloc d'environ
//!   [`PAGE_CHARS`] caractères, coupé entre deux paragraphes.
//! - Markdown / texte : même découpage que Word.
//! - Note (écrite dans Cadence, en Markdown) : une page = une section, coupée avant chaque titre
//!   de niveau 1 à 3 ; une section trop longue est redécoupée comme Word.

use std::{
    io::{Cursor, Read},
    path::Path,
};

use anyhow::{Context, Result, anyhow, bail};
use quick_xml::{Reader, events::Event};
use serde::{Deserialize, Serialize};

/// Taille cible d'une « page » pour les formats sans pagination.
pub const PAGE_CHARS: usize = 3000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum DocKind {
    Pdf,
    Docx,
    Pptx,
    Markdown,
    Text,
    /// Note prise dans Cadence (fichier Markdown rangé dans le dossier des cours).
    Note,
}

impl DocKind {
    pub fn from_path(path: &Path) -> Option<Self> {
        let ext = path.extension()?.to_str()?.to_ascii_lowercase();
        Some(match ext.as_str() {
            "pdf" => DocKind::Pdf,
            "docx" => DocKind::Docx,
            "pptx" => DocKind::Pptx,
            "md" | "markdown" => DocKind::Markdown,
            "txt" | "text" => DocKind::Text,
            _ => return None,
        })
    }

    /// Ce qu'une « page » désigne pour ce format (pour les citations).
    pub fn page_unit(self) -> &'static str {
        match self {
            DocKind::Pdf => "page",
            DocKind::Pptx => "diapositive",
            DocKind::Docx | DocKind::Markdown | DocKind::Text => "bloc d'environ 3000 caractères",
            DocKind::Note => "section",
        }
    }
}

pub const SUPPORTED: &str = "PDF (.pdf), Word (.docx), PowerPoint (.pptx), Markdown (.md) et texte (.txt)";

/// Texte de chaque page d'un fichier.
pub fn extract_file(path: &Path) -> Result<(DocKind, Vec<String>)> {
    let kind = DocKind::from_path(path).ok_or_else(|| {
        anyhow!(
            "Format non pris en charge : {}. Formats acceptés : {SUPPORTED}.",
            path.display()
        )
    })?;
    let bytes = std::fs::read(path).with_context(|| format!("lecture de {}", path.display()))?;
    Ok((kind, extract_bytes(kind, &bytes)?))
}

pub fn extract_bytes(kind: DocKind, bytes: &[u8]) -> Result<Vec<String>> {
    let pages = match kind {
        DocKind::Pdf => pdf_pages(bytes)?,
        DocKind::Docx => chunk_paragraphs(&docx_paragraphs(bytes)?, PAGE_CHARS),
        DocKind::Pptx => pptx_slides(bytes)?,
        DocKind::Markdown | DocKind::Text => {
            let text = String::from_utf8_lossy(bytes);
            let text = text.trim_start_matches('\u{feff}').replace("\r\n", "\n");
            let paragraphs: Vec<String> = text.split("\n\n").map(str::to_string).collect();
            chunk_paragraphs(&paragraphs, PAGE_CHARS)
        }
        // Une note peut être vide : pas de « aucun texte trouvé ».
        DocKind::Note => return Ok(note_pages(&String::from_utf8_lossy(bytes))),
    };
    let pages: Vec<String> = pages.iter().map(|p| tidy(p)).collect();
    if pages.iter().all(|p| p.is_empty()) {
        bail!("Aucun texte trouvé dans le document (PDF scanné sans couche texte ?).");
    }
    Ok(pages)
}

/// Espaces de fin de ligne retirés, au plus une ligne vide d'affilée.
fn tidy(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut blank = 0;
    for line in text.lines().map(str::trim_end) {
        if line.trim().is_empty() {
            blank += 1;
            if blank > 1 || out.is_empty() {
                continue;
            }
        } else {
            blank = 0;
        }
        out.push_str(line);
        out.push('\n');
    }
    out.trim_end().to_string()
}

/* ---------- PDF ---------- */

fn pdf_pages(bytes: &[u8]) -> Result<Vec<String>> {
    // pdf-extract panique sur certains PDF mal formés : on le traite comme une erreur.
    let bytes = bytes.to_vec();
    let result = std::panic::catch_unwind(move || pdf_extract::extract_text_from_mem_by_pages(&bytes));
    match result {
        Ok(Ok(pages)) => Ok(pages),
        Ok(Err(err)) => Err(anyhow!("PDF illisible : {err}")),
        Err(_) => Err(anyhow!(
            "PDF illisible : extraction interrompue (fichier mal formé ou chiffré)."
        )),
    }
}

/* ---------- Office (zip + XML) ---------- */

fn zip_entry(archive: &mut zip::ZipArchive<Cursor<&[u8]>>, name: &str) -> Result<String> {
    let mut file = archive
        .by_name(name)
        .with_context(|| format!("{name} absent du fichier"))?;
    let mut text = String::new();
    file.read_to_string(&mut text)?;
    Ok(text)
}

fn entity(name: &str) -> Option<char> {
    Some(match name {
        "amp" => '&',
        "lt" => '<',
        "gt" => '>',
        "quot" => '"',
        "apos" => '\'',
        _ => return None,
    })
}

/// Paragraphes d'un XML Office : texte des éléments `<x:t>`, un paragraphe par `<x:p>`.
/// `tab` et `br` deviennent tabulation et retour à la ligne.
fn office_paragraphs(xml: &str) -> Result<Vec<String>> {
    let mut reader = Reader::from_str(xml);
    let mut paragraphs = Vec::new();
    let mut current = String::new();
    let mut in_text = false;
    loop {
        match reader.read_event().context("XML illisible")? {
            Event::Start(e) if e.local_name().as_ref() == "t" => in_text = true,
            Event::End(e) => match e.local_name().as_ref() {
                "t" => in_text = false,
                "p" => paragraphs.push(std::mem::take(&mut current)),
                _ => {}
            },
            Event::Empty(e) => match e.local_name().as_ref() {
                "tab" => current.push('\t'),
                "br" | "cr" => current.push('\n'),
                _ => {}
            },
            Event::Text(t) if in_text => current.push_str(&t.xml10_content()),
            Event::GeneralRef(r) if in_text => {
                if let Some(c) = r.resolve_char_ref().ok().flatten() {
                    current.push(c);
                } else if let Some(c) = entity(&r.xml10_content()) {
                    current.push(c);
                }
            }
            Event::Eof => break,
            _ => {}
        }
    }
    if !current.is_empty() {
        paragraphs.push(current);
    }
    Ok(paragraphs)
}

fn docx_paragraphs(bytes: &[u8]) -> Result<Vec<String>> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).context("fichier Word illisible (zip)")?;
    office_paragraphs(&zip_entry(&mut archive, "word/document.xml")?)
}

/// Numéro d'une diapositive : `ppt/slides/slide12.xml` → 12.
fn slide_number(name: &str) -> Option<u32> {
    name.strip_prefix("ppt/slides/slide")?
        .strip_suffix(".xml")?
        .parse()
        .ok()
}

fn pptx_slides(bytes: &[u8]) -> Result<Vec<String>> {
    let mut archive =
        zip::ZipArchive::new(Cursor::new(bytes)).context("fichier PowerPoint illisible (zip)")?;
    let mut slides: Vec<(u32, String)> = archive
        .file_names()
        .filter_map(Result::ok)
        .filter_map(|n| slide_number(&n).map(|i| (i, n.to_string())))
        .collect();
    slides.sort_by_key(|(i, _)| *i);
    if slides.is_empty() {
        bail!("Aucune diapositive dans le fichier PowerPoint.");
    }
    slides
        .into_iter()
        .map(|(_, name)| Ok(office_paragraphs(&zip_entry(&mut archive, &name)?)?.join("\n")))
        .collect()
}

/* ---------- Découpage ---------- */

/// Regroupe des paragraphes en pages d'environ `target` caractères, sans couper un paragraphe
/// sauf s'il dépasse à lui seul la cible (coupé alors sur un espace).
pub fn chunk_paragraphs(paragraphs: &[String], target: usize) -> Vec<String> {
    let mut pages = Vec::new();
    let mut page = String::new();
    let len = |s: &str| s.chars().count();
    for p in paragraphs
        .iter()
        .map(|p| p.trim_end())
        .filter(|p| !p.trim().is_empty())
    {
        if !page.is_empty() && len(&page) + 1 + len(p) > target {
            pages.push(std::mem::take(&mut page));
        }
        if len(p) > target {
            let mut rest = p;
            while len(rest) > target {
                let cut = split_point(rest, target);
                pages.push(rest[..cut].trim_end().to_string());
                rest = rest[cut..].trim_start();
            }
            page = rest.to_string();
            continue;
        }
        if !page.is_empty() {
            page.push('\n');
        }
        page.push_str(p);
    }
    if !page.trim().is_empty() {
        pages.push(page);
    }
    pages
}

/// Titre Markdown qui ouvre une section de note (`#` à `###` suivi d'un espace) : son texte.
fn section_heading(line: &str) -> Option<&str> {
    let hashes = line.len() - line.trim_start_matches('#').len();
    let rest = &line[hashes..];
    if (1..=3).contains(&hashes) && rest.starts_with([' ', '\t']) && !rest.trim().is_empty() {
        Some(rest.trim().trim_end_matches('#').trim_end())
    } else {
        None
    }
}

/// Début ou fin d'un bloc de code (```` ``` ```` ou `~~~`).
fn is_fence(line: &str) -> bool {
    let l = line.trim_start();
    l.starts_with("```") || l.starts_with("~~~")
}

/// Sections d'une note : une page avant chaque titre de niveau 1 à 3 (hors blocs de code), le
/// texte qui précède le premier titre formant la première page. Une section de plus de
/// [`PAGE_CHARS`] caractères est redécoupée entre deux paragraphes. Toujours au moins une page,
/// vide pour une note vide.
pub fn note_pages(markdown: &str) -> Vec<String> {
    let text = markdown.trim_start_matches('\u{feff}').replace("\r\n", "\n");
    let mut sections: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut in_code = false;
    for line in text.lines() {
        if is_fence(line) {
            in_code = !in_code;
        } else if !in_code && section_heading(line).is_some() && !current.trim().is_empty() {
            sections.push(std::mem::take(&mut current));
        }
        current.push_str(line);
        current.push('\n');
    }
    if !current.trim().is_empty() {
        sections.push(current);
    }
    let mut pages = Vec::new();
    for section in &sections {
        let section = section.trim_matches('\n').trim_end();
        if section.chars().count() <= PAGE_CHARS {
            pages.push(section.to_string());
        } else {
            let paragraphs: Vec<String> = section.split("\n\n").map(str::to_string).collect();
            pages.extend(chunk_paragraphs(&paragraphs, PAGE_CHARS));
        }
    }
    if pages.is_empty() {
        pages.push(String::new());
    }
    pages
}

/// Titre d'une section de note : sa première ligne, si c'est un titre Markdown.
pub fn section_title(page: &str) -> Option<String> {
    page.lines().next().and_then(section_heading).map(str::to_string)
}

/// Indice d'octet où couper `text` pour rester sous `target` caractères, sur un espace si possible.
fn split_point(text: &str, target: usize) -> usize {
    let hard = text
        .char_indices()
        .nth(target)
        .map(|(i, _)| i)
        .unwrap_or(text.len());
    text[..hard]
        .rfind(char::is_whitespace)
        .filter(|&i| i > hard / 2)
        .unwrap_or(hard)
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use std::io::Write;
    use zip::write::SimpleFileOptions;

    /// Archive zip en mémoire (fichiers Office de test).
    pub fn zip_of(files: &[(&str, &str)]) -> Vec<u8> {
        let mut w = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for (name, content) in files {
            w.start_file(*name, SimpleFileOptions::default()).unwrap();
            w.write_all(content.as_bytes()).unwrap();
        }
        w.finish().unwrap().into_inner()
    }

    pub fn docx(paragraphs: &[&str]) -> Vec<u8> {
        let body: String = paragraphs
            .iter()
            .map(|p| format!("<w:p><w:r><w:t xml:space=\"preserve\">{p}</w:t></w:r></w:p>"))
            .collect();
        let xml = format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?><w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:body>{body}</w:body></w:document>"
        );
        zip_of(&[("[Content_Types].xml", "<Types/>"), ("word/document.xml", &xml)])
    }

    pub fn pptx(slides: &[&str]) -> Vec<u8> {
        let xmls: Vec<(String, String)> = slides
            .iter()
            .enumerate()
            .map(|(i, text)| {
                let paras: String = text.split('|').map(|t| format!("<a:p><a:r><a:t>{t}</a:t></a:r></a:p>")).collect();
                (
                    format!("ppt/slides/slide{}.xml", i + 1),
                    format!(
                        "<p:sld xmlns:p=\"http://schemas.openxmlformats.org/presentationml/2006/main\" xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\"><p:cSld><p:spTree><p:sp><p:txBody>{paras}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>"
                    ),
                )
            })
            .collect();
        let files: Vec<(&str, &str)> = xmls.iter().map(|(n, x)| (n.as_str(), x.as_str())).collect();
        zip_of(&files)
    }

    /// PDF de test : une page par texte, police Courier standard.
    pub fn pdf(pages: &[&str]) -> Vec<u8> {
        use pdf_extract::{
            Dictionary, Document, Object, Stream,
            content::{Content, Operation},
        };
        let mut doc = Document::with_version("1.5");
        let pages_id = doc.new_object_id();
        let mut font = Dictionary::new();
        font.set("Type", Object::Name(b"Font".to_vec()));
        font.set("Subtype", Object::Name(b"Type1".to_vec()));
        font.set("BaseFont", Object::Name(b"Courier".to_vec()));
        let font_id = doc.add_object(font);
        let mut fonts = Dictionary::new();
        fonts.set("F1", Object::Reference(font_id));
        let mut resources = Dictionary::new();
        resources.set("Font", Object::Dictionary(fonts));
        let resources_id = doc.add_object(resources);
        let mut kids = Vec::new();
        for text in pages {
            let content = Content {
                operations: vec![
                    Operation::new("BT", vec![]),
                    Operation::new("Tf", vec![Object::Name(b"F1".to_vec()), 24.into()]),
                    Operation::new("Td", vec![72.into(), 700.into()]),
                    Operation::new("Tj", vec![Object::string_literal(*text)]),
                    Operation::new("ET", vec![]),
                ],
            };
            let content_id = doc.add_object(Stream::new(Dictionary::new(), content.encode().unwrap()));
            let mut page = Dictionary::new();
            page.set("Type", Object::Name(b"Page".to_vec()));
            page.set("Parent", Object::Reference(pages_id));
            page.set("Contents", Object::Reference(content_id));
            kids.push(Object::Reference(doc.add_object(page)));
        }
        let mut root = Dictionary::new();
        root.set("Type", Object::Name(b"Pages".to_vec()));
        root.set("Count", Object::Integer(kids.len() as i64));
        root.set("Kids", Object::Array(kids));
        root.set("Resources", Object::Reference(resources_id));
        root.set(
            "MediaBox",
            Object::Array(vec![0.into(), 0.into(), 595.into(), 842.into()]),
        );
        doc.objects.insert(pages_id, Object::Dictionary(root));
        let mut catalog = Dictionary::new();
        catalog.set("Type", Object::Name(b"Catalog".to_vec()));
        catalog.set("Pages", Object::Reference(pages_id));
        let catalog_id = doc.add_object(catalog);
        doc.trailer.set("Root", Object::Reference(catalog_id));
        let mut out = Vec::new();
        doc.save_to(&mut out).unwrap();
        out
    }

    #[test]
    fn extracts_pdf_pages() {
        let pages = extract_bytes(DocKind::Pdf, &pdf(&["Bonjour page une", "Chapitre deux"])).unwrap();
        assert_eq!(pages.len(), 2);
        assert!(pages[0].contains("Bonjour page une"), "{pages:?}");
        assert!(pages[1].contains("Chapitre deux"), "{pages:?}");
    }

    #[test]
    fn rejects_broken_pdf() {
        assert!(extract_bytes(DocKind::Pdf, b"%PDF-1.4 pas vraiment").is_err());
    }

    #[test]
    fn extracts_docx_paragraphs_and_entities() {
        let pages = extract_bytes(
            DocKind::Docx,
            &docx(&["Titre du cours", "L&apos;atome &amp; ses électrons"]),
        )
        .unwrap();
        assert_eq!(pages, ["Titre du cours\nL'atome & ses électrons"]);
    }

    #[test]
    fn splits_long_docx_into_blocks() {
        let para = "mot ".repeat(350); // 1400 caractères
        let paras: Vec<&str> = vec![para.as_str(); 4];
        let pages = extract_bytes(DocKind::Docx, &docx(&paras)).unwrap();
        assert_eq!(
            pages.len(),
            2,
            "deux paragraphes par bloc de 3000 au plus : {:?}",
            pages.iter().map(|p| p.len()).collect::<Vec<_>>()
        );
        assert!(pages.iter().all(|p| p.chars().count() <= PAGE_CHARS));
    }

    #[test]
    fn extracts_pptx_slides_in_order() {
        let mut slides: Vec<String> = (1..=11).map(|i| format!("Diapo {i}|Point {i}")).collect();
        slides[9] = "Dixième|fin".into();
        let refs: Vec<&str> = slides.iter().map(String::as_str).collect();
        let pages = extract_bytes(DocKind::Pptx, &pptx(&refs)).unwrap();
        assert_eq!(pages.len(), 11);
        assert_eq!(pages[0], "Diapo 1\nPoint 1");
        assert_eq!(pages[1], "Diapo 2\nPoint 2", "slide2 avant slide10");
        assert_eq!(pages[9], "Dixième\nfin");
    }

    #[test]
    fn extracts_markdown_and_text() {
        let md = "# Thermodynamique\r\n\r\nPremier principe.\r\n\r\n\r\n\r\nSecond principe.";
        assert_eq!(
            extract_bytes(DocKind::Markdown, md.as_bytes()).unwrap(),
            ["# Thermodynamique\nPremier principe.\nSecond principe."]
        );
        assert!(extract_bytes(DocKind::Text, b"   \n\n").is_err());
    }

    #[test]
    fn chunks_without_losing_text() {
        let long = "a".repeat(7000);
        let pages = chunk_paragraphs(&[long.clone()], 3000);
        assert_eq!(pages.iter().map(String::len).sum::<usize>(), 7000);
        assert_eq!(pages.len(), 3);
        let words = "un deux trois quatre ".repeat(300);
        let pages = chunk_paragraphs(&[words], 3000);
        assert!(
            pages
                .iter()
                .all(|p| !p.ends_with(' ') && p.chars().count() <= 3000)
        );
    }

    #[test]
    fn splits_notes_by_headings() {
        let md = "Intro avant tout titre.\n\n# Atomes\n\nLe noyau.\n\n## Électrons\r\n\n- couche K\n\n```\n# pas un titre\n```\n\n#### Détail\nreste dans la section\n\n#mot-clé n'est pas un titre\n# Liaisons #\nCovalente.";
        let pages = note_pages(md);
        assert_eq!(pages.len(), 4, "{pages:#?}");
        assert_eq!(pages[0], "Intro avant tout titre.");
        assert_eq!(pages[1], "# Atomes\n\nLe noyau.");
        assert!(pages[2].starts_with("## Électrons\n"), "{:?}", pages[2]);
        assert!(pages[2].contains("# pas un titre") && pages[2].contains("#### Détail"));
        assert!(pages[2].ends_with("#mot-clé n'est pas un titre"));
        assert_eq!(pages[3], "# Liaisons #\nCovalente.");
        let titles: Vec<Option<String>> = pages.iter().map(|p| section_title(p)).collect();
        assert_eq!(
            titles,
            [
                None,
                Some("Atomes".into()),
                Some("Électrons".into()),
                Some("Liaisons".into())
            ]
        );

        // Note vide : une page vide ; section trop longue : redécoupée entre deux paragraphes.
        assert_eq!(note_pages("  \n\n"), [""]);
        assert_eq!(extract_bytes(DocKind::Note, b"").unwrap(), [""]);
        let long = format!("# Long\n\n{}", vec!["mot ".repeat(350); 4].join("\n\n"));
        let pages = note_pages(&long);
        assert_eq!(pages.len(), 2);
        assert!(pages.iter().all(|p| p.chars().count() <= PAGE_CHARS));
    }

    #[test]
    fn knows_formats() {
        assert_eq!(DocKind::from_path(Path::new("Cours.PDF")), Some(DocKind::Pdf));
        assert_eq!(
            DocKind::from_path(Path::new("notes.markdown")),
            Some(DocKind::Markdown)
        );
        assert_eq!(DocKind::from_path(Path::new("image.png")), None);
        assert_eq!(slide_number("ppt/slides/slide12.xml"), Some(12));
        assert_eq!(slide_number("ppt/slides/_rels/slide1.xml.rels"), None);
    }
}
