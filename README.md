# Wypożyczalnia Hufca

Wypożyczalnia sprzętu Karkonoskiego Hufca ZHP: spis rzeczy z naklejkami QR, wypożyczenia, zwroty, usterki, wnioski drużynowych i historia każdego ruchu.

Adres: https://piotrekkwiatek.github.io/wypozyczalnia/

Kody QR na naklejkach prowadzą pod ten adres (`…/wypozyczalnia/#KOD`), więc po wydrukowaniu prawdziwych naklejek adresu nie zmieniamy.

## Jak to działa

- Strona stoi na GitHub Pages, dane i logowanie są w Firebase (projekt `inwentarz-hufca`, baza w Warszawie, europe-central2).
- Logowanie mailem i hasłem. Dostęp i rolę nadaje admin w zakładce „Użytkownicy” (lista maili):
  - **admin** – wszystko, także lista użytkowników i kategorii,
  - **biuro hufca** – wydawanie, zwroty, plany, wnioski, usterki,
  - **drużynowy / instruktor** – kafelki kategorii z tym, co jest teraz dostępne (miejsce na drugim planie), i wnioski o sprzęt.
- Na telefonie stronę można dodać do ekranu (iPhone: Safari → Udostępnij → Do ekranu początkowego; Android: Chrome → ⋮ → Zainstaluj aplikację).

## Pliki

- `index.html` – aplikacja.
- `prod.js` – role, widok drużynowego, wnioski, użytkownicy, kategorie u drużynowych, instalacja na telefonie, oszczędne wczytywanie historii.
- `fb.js` – logowanie i połączenie z bazą Firebase; `config.js` – ustawienia projektu Firebase (nie są tajne).
- `firestore.rules` – reguły dostępu do bazy (w miejsce OWNER_EMAIL wpisany jest mail pierwszego admina w konsoli Firebase).
- `sw.js`, `manifest.webmanifest`, `icons/` – aplikacja na telefonie i praca przy słabym zasięgu.
- `vendor/` – biblioteki (Firebase, kody QR, PDF, Excel), trzymane tutaj, żeby działały bez zewnętrznych serwerów.

Wersja testowa (każdy ma własną kopię danych w przeglądarce) jest osobno: https://piotrekkwiatek.github.io/inwentarz/
