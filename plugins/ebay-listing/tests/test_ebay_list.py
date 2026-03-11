"""Tests for ebay_list.py — covers pure functions, XML building, and mocked API calls."""
import os
import re
import pytest
from unittest.mock import patch, MagicMock

import ebay_list


# ---- Pure functions ----


class TestEscapeXml:
    def test_ampersand(self):
        assert ebay_list._escape_xml("A & B") == "A &amp; B"

    def test_angle_brackets(self):
        assert ebay_list._escape_xml("<tag>") == "&lt;tag&gt;"

    def test_quotes(self):
        assert ebay_list._escape_xml('"hello\'') == "&quot;hello&apos;"

    def test_no_change(self):
        assert ebay_list._escape_xml("plain text 123") == "plain text 123"

    def test_all_specials(self):
        result = ebay_list._escape_xml("a&b<c>d\"e'f")
        assert result == "a&amp;b&lt;c&gt;d&quot;e&apos;f"

    def test_empty(self):
        assert ebay_list._escape_xml("") == ""


class TestExtractXmlValue:
    def test_simple(self):
        xml = "<Response><Ack>Success</Ack></Response>"
        assert ebay_list._extract_xml_value(xml, "Ack") == "Success"

    def test_missing_tag(self):
        assert ebay_list._extract_xml_value("<Foo>bar</Foo>", "Baz") == ""

    def test_multiline(self):
        xml = "<Error>\n  <Message>Something\nwent wrong</Message>\n</Error>"
        assert ebay_list._extract_xml_value(xml, "Message") == "Something\nwent wrong"

    def test_nested(self):
        xml = "<Root><Item><ItemID>12345</ItemID></Item></Root>"
        assert ebay_list._extract_xml_value(xml, "ItemID") == "12345"

    def test_empty_tag(self):
        assert ebay_list._extract_xml_value("<Tag></Tag>", "Tag") == ""


class TestSearchCategories:
    def test_single_keyword(self):
        results = ebay_list.search_categories("drone")
        assert len(results) > 0
        ids = [r["id"] for r in results]
        assert "179697" in ids  # Camera Drones

    def test_multiple_keywords(self):
        results = ebay_list.search_categories("camera drone")
        assert results[0]["id"] == "179697"

    def test_no_match(self):
        results = ebay_list.search_categories("xyzzyplugh")
        assert results == []

    def test_by_id(self):
        results = ebay_list.search_categories("179697")
        assert any(r["id"] == "179697" for r in results)


class TestSuggestCategory:
    def test_title_match(self):
        results = ebay_list.suggest_category("DJI Camera Drone FPV")
        assert len(results) > 0
        ids = [r["id"] for r in results]
        assert "179697" in ids

    def test_fallback_individual_words(self):
        results = ebay_list.suggest_category("New headphones wireless")
        assert len(results) > 0
        ids = [r["id"] for r in results]
        assert "112529" in ids

    def test_no_match(self):
        results = ebay_list.suggest_category("asdlkfjasldkfj")
        assert results == []


# ---- Constants / maps ----


class TestConstants:
    def test_condition_id_map_completeness(self):
        for cond in ebay_list.CONDITIONS:
            assert cond in ebay_list.CONDITION_ID_MAP

    def test_site_id_map(self):
        assert ebay_list.SITE_ID_MAP["AU"] == "15"
        assert ebay_list.SITE_ID_MAP["US"] == "0"

    def test_mascot_pickup_preset(self):
        preset = ebay_list.LISTING_PRESETS["mascot-pickup"]
        assert preset["marketplace"] == "AU"
        assert preset["currency"] == "AUD"
        assert preset["postcode"] == "2020"
        assert preset["no_returns"] is True
        assert preset["best_offer"] is True
        services = [s["service"] for s in preset["domestic_services"]]
        assert "AU_Regular" in services
        assert "AU_Pickup" in services


class TestHelpers:
    def test_api_base_production(self):
        assert ebay_list.api_base(False) == "https://api.ebay.com"

    def test_api_base_sandbox(self):
        assert ebay_list.api_base(True) == "https://api.sandbox.ebay.com"

    def test_auth_base(self):
        assert ebay_list.auth_base(False) == "https://auth.ebay.com"
        assert ebay_list.auth_base(True) == "https://auth.sandbox.ebay.com"

    def test_basic_auth_header(self):
        result = ebay_list.basic_auth_header("client", "secret")
        assert result.startswith("Basic ")
        import base64
        decoded = base64.b64decode(result.split(" ", 1)[1]).decode()
        assert decoded == "client:secret"

    def test_get_auth_mode_authnauth(self):
        with patch.dict(os.environ, {"EBAY_AUTH_TOKEN": "tok123"}):
            assert ebay_list.get_auth_mode() == "authnauth"

    def test_get_auth_mode_oauth(self):
        env = {k: "" for k in ["EBAY_AUTH_TOKEN"]}
        with patch.dict(os.environ, env, clear=False):
            os.environ.pop("EBAY_AUTH_TOKEN", None)
            assert ebay_list.get_auth_mode() == "oauth"


# ---- XML building ----


class TestBuildListingXml:
    def _build(self, **overrides):
        defaults = dict(
            title="Test Item",
            description="A test description",
            price=99.99,
            condition_id="3000",
            image_urls=["https://example.com/img1.jpg"],
            quantity=1,
            category_id="31388",
            currency="AUD",
            marketplace="AU",
        )
        defaults.update(overrides)
        return ebay_list._build_listing_xml(**defaults)

    def test_basic_fields(self):
        xml = self._build()
        assert "<Title>Test Item</Title>" in xml
        assert "<StartPrice" in xml and "99.99" in xml
        assert "<ConditionID>3000</ConditionID>" in xml
        assert "<Country>AU</Country>" in xml
        assert "<Currency>AUD</Currency>" in xml
        assert "<Quantity>1</Quantity>" in xml
        assert "<ListingDuration>GTC</ListingDuration>" in xml
        assert "<ListingType>FixedPriceItem</ListingType>" in xml

    def test_category(self):
        xml = self._build(category_id="179697")
        assert "<CategoryID>179697</CategoryID>" in xml

    def test_no_category(self):
        xml = self._build(category_id="")
        assert "<PrimaryCategory>" not in xml

    def test_images(self):
        xml = self._build(image_urls=["https://a.com/1.jpg", "https://a.com/2.jpg"])
        assert xml.count("<PictureURL>") == 2

    def test_description_cdata(self):
        xml = self._build(description="<b>Bold</b> text")
        assert "<![CDATA[<b>Bold</b> text]]>" in xml

    def test_xml_escaping_in_title(self):
        xml = self._build(title="Item & 'Stuff' <Special>")
        assert "Item &amp; &apos;Stuff&apos; &lt;Special&gt;" in xml

    def test_item_specifics(self):
        xml = self._build(item_specifics={"Brand": "Sony", "Colour": "Black"})
        assert "<ItemSpecifics>" in xml
        assert "<Name>Brand</Name>" in xml
        assert "<Value>Sony</Value>" in xml
        assert "<Name>Colour</Name>" in xml

    def test_no_item_specifics(self):
        xml = self._build(item_specifics=None)
        assert "<ItemSpecifics>" not in xml

    def test_best_offer(self):
        xml = self._build(best_offer=True)
        assert "<BestOfferEnabled>true</BestOfferEnabled>" in xml

    def test_best_offer_thresholds(self):
        xml = self._build(
            best_offer=True,
            best_offer_auto_accept=80.0,
            best_offer_min=50.0,
        )
        assert "<BestOfferAutoAcceptPrice" in xml
        assert "80.0" in xml
        assert "<MinimumBestOfferPrice" in xml
        assert "50.0" in xml

    def test_no_best_offer(self):
        xml = self._build(best_offer=False)
        assert "BestOfferEnabled" not in xml

    def test_returns_accepted(self):
        xml = self._build(returns_accepted=True, return_days=30)
        assert "<ReturnsAcceptedOption>ReturnsAccepted</ReturnsAcceptedOption>" in xml
        assert "Days_30" in xml

    def test_no_returns(self):
        xml = self._build(returns_accepted=False)
        assert "<ReturnsAcceptedOption>ReturnsNotAccepted</ReturnsAcceptedOption>" in xml
        assert "Days_" not in xml

    def test_postcode_and_location(self):
        xml = self._build(postcode="2020", location="Mascot, NSW")
        assert "<PostalCode>2020</PostalCode>" in xml
        assert "<Location>Mascot, NSW</Location>" in xml

    def test_condition_description(self):
        xml = self._build(condition_description="Minor wear on sole")
        assert "<ConditionDescription>Minor wear on sole</ConditionDescription>" in xml

    def test_domestic_shipping_flat(self):
        xml = self._build(
            shipping_type="Flat",
            domestic_services=[
                {"service": "AU_Regular", "cost": 15.0},
                {"service": "AU_Pickup"},
            ],
        )
        assert "<ShippingType>Flat</ShippingType>" in xml
        assert "<ShippingService>AU_Regular</ShippingService>" in xml
        assert "<ShippingServiceCost" in xml and "15.0" in xml
        assert "<ShippingService>AU_Pickup</ShippingService>" in xml

    def test_domestic_shipping_free(self):
        xml = self._build(
            domestic_services=[{"service": "AU_Regular", "free": True}],
        )
        assert "<FreeShipping>true</FreeShipping>" in xml

    def test_international_shipping(self):
        xml = self._build(
            international_services=[
                {"service": "AU_AusPostRegisteredPostInternationalParcel", "cost": 150, "ship_to": "Worldwide"},
            ],
        )
        assert "<InternationalShippingServiceOption>" in xml
        assert "150" in xml
        assert "<ShipToLocation>Worldwide</ShipToLocation>" in xml

    def test_calculated_shipping_dimensions(self):
        xml = self._build(
            shipping_type="CalculatedDomesticFlatInternational",
            package_type="PaddedBags",
            package_length=40.0,
            package_width=25.0,
            package_depth=20.0,
            weight_kg=5.5,
        )
        assert "<ShippingPackage>PaddedBags</ShippingPackage>" in xml
        assert 'unit="cm">40.0</PackageLength>' in xml
        assert 'unit="kg">5</WeightMajor>' in xml
        assert 'unit="gm">500</WeightMinor>' in xml

    def test_gallery_plus(self):
        xml = self._build(gallery_type="Plus")
        assert "<GalleryType>Plus</GalleryType>" in xml

    def test_dispatch_days(self):
        xml = self._build(dispatch_days=5)
        assert "<DispatchTimeMax>5</DispatchTimeMax>" in xml

    def test_ship_to_locations(self):
        xml = self._build(ship_to_locations="Worldwide")
        assert "<ShipToLocations>Worldwide</ShipToLocations>" in xml


# ---- Mocked API calls ----


class TestResolveCondition:
    def test_direct_match(self):
        """When desired condition is valid for the category, use it directly."""
        mock_conditions = [
            {"id": "1000", "name": "New"},
            {"id": "3000", "name": "Used"},
        ]
        with patch.object(ebay_list, "get_valid_conditions", return_value=mock_conditions):
            result = ebay_list.resolve_condition("LIKE_NEW", "31388", "tok", False, "15")
            assert result == "3000"

    def test_fallback_to_closest(self):
        """When desired condition is invalid, pick the closest valid one."""
        mock_conditions = [
            {"id": "1000", "name": "New"},
            {"id": "4000", "name": "Used - Very Good"},
        ]
        with patch.object(ebay_list, "get_valid_conditions", return_value=mock_conditions):
            result = ebay_list.resolve_condition("USED_GOOD", "31388", "tok", False, "15")
            # USED_GOOD (quality 7) is closer to "Very Good" (quality 6) than "New" (quality 0)
            assert result == "4000"

    def test_no_conditions_from_api(self):
        """When API returns no conditions, use static map."""
        with patch.object(ebay_list, "get_valid_conditions", return_value=[]):
            result = ebay_list.resolve_condition("NEW", "31388", "tok", False, "15")
            assert result == "1000"

    def test_pre_owned(self):
        """Pre-Owned maps to middle quality."""
        mock_conditions = [
            {"id": "1000", "name": "New"},
            {"id": "3000", "name": "Pre-Owned"},
        ]
        with patch.object(ebay_list, "get_valid_conditions", return_value=mock_conditions):
            result = ebay_list.resolve_condition("USED_EXCELLENT", "31388", "tok", False, "15")
            # USED_EXCELLENT quality=5, Pre-Owned quality=6 — close match
            assert result == "3000"


class TestResolveImages:
    def test_url_passthrough(self):
        urls = ["https://example.com/a.jpg", "https://example.com/b.jpg"]
        result = ebay_list.resolve_images(urls)
        assert result == urls

    def test_missing_file_raises(self):
        with pytest.raises(ebay_list.EbayApiError, match="Image not found"):
            ebay_list.resolve_images(["/nonexistent/path.jpg"])

    def test_local_file_no_token_raises(self):
        with patch("os.path.isfile", return_value=True):
            with pytest.raises(ebay_list.EbayApiError, match="requires Auth"):
                ebay_list.resolve_images(["local.jpg"], auth_token="")

    def test_local_file_upload(self):
        with patch("os.path.isfile", return_value=True):
            with patch.object(ebay_list, "upload_picture", return_value="https://ebay.com/hosted.jpg"):
                result = ebay_list.resolve_images(["local.jpg"], auth_token="tok123")
                assert result == ["https://ebay.com/hosted.jpg"]


class TestValidateLeafCategory:
    def test_leaf_category(self):
        fake_xml = """<GetCategoriesResponse>
            <Category>
                <CategoryID>179697</CategoryID>
                <CategoryName>Camera Drones</CategoryName>
                <CategoryParentID>625</CategoryParentID>
                <LeafCategory>true</LeafCategory>
            </Category>
        </GetCategoriesResponse>"""
        with patch.object(ebay_list, "_trading_api_call_safe", return_value=fake_xml):
            is_leaf, name = ebay_list.validate_leaf_category("179697", "tok", False, "15")
            assert is_leaf is True
            assert name == "Camera Drones"

    def test_non_leaf_category(self):
        fake_xml = """<GetCategoriesResponse>
            <Category>
                <CategoryID>15032</CategoryID>
                <CategoryName>Power Tools</CategoryName>
                <CategoryParentID>631</CategoryParentID>
            </Category>
        </GetCategoriesResponse>"""
        with patch.object(ebay_list, "_trading_api_call_safe", return_value=fake_xml):
            is_leaf, name = ebay_list.validate_leaf_category("15032", "tok", False, "15")
            assert is_leaf is False
            assert name == "Power Tools"

    def test_api_failure_returns_true(self):
        """When API fails, don't block — assume leaf."""
        with patch.object(ebay_list, "_trading_api_call_safe", return_value=None):
            is_leaf, name = ebay_list.validate_leaf_category("12345", "tok", False, "15")
            assert is_leaf is True
            assert name == ""


class TestTradingApiCall:
    def test_success(self):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.text = "<Ack>Success</Ack>"
        with patch("requests.post", return_value=mock_resp):
            result = ebay_list.trading_api_call("GetItem", "<ItemID>123</ItemID>", "tok")
            assert "<Ack>Success</Ack>" in result

    def test_http_error_raises(self):
        mock_resp = MagicMock()
        mock_resp.status_code = 500
        mock_resp.text = "Internal Server Error"
        with patch("requests.post", return_value=mock_resp):
            with pytest.raises(ebay_list.EbayApiError, match="Trading API error: 500"):
                ebay_list.trading_api_call("GetItem", "<ItemID>123</ItemID>", "tok")

    def test_xml_structure(self):
        """Verify the XML request wraps body correctly."""
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.text = "<Ack>Success</Ack>"
        with patch("requests.post", return_value=mock_resp) as mock_post:
            ebay_list.trading_api_call("TestCall", "<Body>content</Body>", "mytoken", site_id="15")
            posted_data = mock_post.call_args[1]["data"].decode("utf-8")
            assert "<TestCallRequest" in posted_data
            assert "<eBayAuthToken>mytoken</eBayAuthToken>" in posted_data
            assert "<Body>content</Body>" in posted_data
            assert mock_post.call_args[1]["headers"]["X-EBAY-API-SITEID"] == "15"


class TestFindCategoriesOnline:
    def test_keyword_filter(self):
        fake_xml = """<GetCategoriesResponse><Ack>Success</Ack>
            <Category>
                <CategoryID>9355</CategoryID>
                <CategoryName>Mobile Phones</CategoryName>
                <CategoryParentID>15032</CategoryParentID>
                <LeafCategory>true</LeafCategory>
            </Category>
            <Category>
                <CategoryID>20349</CategoryID>
                <CategoryName>Cases &amp; Covers</CategoryName>
                <CategoryParentID>9394</CategoryParentID>
                <LeafCategory>true</LeafCategory>
            </Category>
        </GetCategoriesResponse>"""
        with patch.object(ebay_list, "_trading_api_call_safe", return_value=fake_xml):
            results = ebay_list.find_categories_online("mobile phones", "tok", False, "15")
            assert len(results) == 1
            assert results[0]["id"] == "9355"
            assert results[0]["leaf"] is True

    def test_parent_filter_no_keyword_filter(self):
        """When parent_id is set, return all children without keyword filtering."""
        fake_xml = """<GetCategoriesResponse><Ack>Success</Ack>
            <Category>
                <CategoryID>100</CategoryID>
                <CategoryName>Subcategory A</CategoryName>
                <CategoryParentID>50</CategoryParentID>
                <LeafCategory>true</LeafCategory>
            </Category>
        </GetCategoriesResponse>"""
        with patch.object(ebay_list, "_trading_api_call_safe", return_value=fake_xml):
            results = ebay_list.find_categories_online("anything", "tok", False, "15", parent_id="50")
            assert len(results) == 1

    def test_api_failure(self):
        with patch.object(ebay_list, "_trading_api_call_safe", return_value=None):
            results = ebay_list.find_categories_online("test", "tok", False, "15")
            assert results == []


class TestGetCategorySpecifics:
    def test_parses_specifics(self):
        fake_xml = """<GetCategorySpecificsResponse><Ack>Success</Ack>
            <Recommendations>
                <NameRecommendation>
                    <Name>Brand</Name>
                    <ValidationRules><UsageConstraint>Required</UsageConstraint><MinValues>1</MinValues></ValidationRules>
                    <ValueRecommendation><Value>Apple</Value></ValueRecommendation>
                    <ValueRecommendation><Value>Samsung</Value></ValueRecommendation>
                </NameRecommendation>
                <NameRecommendation>
                    <Name>Colour</Name>
                    <ValidationRules><UsageConstraint>Recommended</UsageConstraint><MinValues>0</MinValues></ValidationRules>
                    <ValueRecommendation><Value>Black</Value></ValueRecommendation>
                </NameRecommendation>
            </Recommendations>
        </GetCategorySpecificsResponse>"""
        with patch.object(ebay_list, "trading_api_call", return_value=fake_xml):
            specs = ebay_list.get_category_specifics("9355", "tok", False, "15")
            assert len(specs) == 2
            brand = next(s for s in specs if s["name"] == "Brand")
            assert brand["required"] is True
            assert "Apple" in brand["values"]
            colour = next(s for s in specs if s["name"] == "Colour")
            assert colour["required"] is False

    def test_api_failure_raises(self):
        fake_xml = "<GetCategorySpecificsResponse><Ack>Failure</Ack><Errors><LongMessage>Oops</LongMessage></Errors></GetCategorySpecificsResponse>"
        with patch.object(ebay_list, "trading_api_call", return_value=fake_xml):
            with pytest.raises(ebay_list.EbayApiError, match="GetCategorySpecifics failed"):
                ebay_list.get_category_specifics("9355", "tok", False, "15")


class TestTradingAddFixedPriceItem:
    def _mock_success(self, item_id="287190999999"):
        return f"""<AddFixedPriceItemResponse>
            <Ack>Success</Ack>
            <ItemID>{item_id}</ItemID>
        </AddFixedPriceItemResponse>"""

    def _mock_verify_success(self):
        return """<VerifyAddFixedPriceItemResponse>
            <Ack>Success</Ack>
            <ItemID>0</ItemID>
            <Fees><Fee><Name>InsertionFee</Name><Fee>0.0</Fee></Fee></Fees>
        </VerifyAddFixedPriceItemResponse>"""

    def test_successful_listing(self):
        with patch.object(ebay_list, "resolve_condition", return_value="3000"):
            with patch.object(ebay_list, "trading_api_call", return_value=self._mock_success("12345")):
                item_id = ebay_list.trading_add_fixed_price_item(
                    title="Test",
                    description="Desc",
                    price=50.0,
                    condition="USED_GOOD",
                    image_urls=["https://example.com/img.jpg"],
                    category_id="31388",
                    currency="AUD",
                    marketplace="AU",
                    auth_token="tok",
                )
                assert item_id == "12345"

    def test_verify_mode(self):
        with patch.object(ebay_list, "resolve_condition", return_value="3000"):
            with patch.object(ebay_list, "trading_api_call", return_value=self._mock_verify_success()) as mock_call:
                ebay_list.trading_add_fixed_price_item(
                    title="Test",
                    description="Desc",
                    price=50.0,
                    condition="USED_GOOD",
                    image_urls=["https://example.com/img.jpg"],
                    auth_token="tok",
                    draft=True,
                )
                assert mock_call.call_args[0][0] == "VerifyAddFixedPriceItem"

    def test_failure_raises(self):
        failure_xml = """<AddFixedPriceItemResponse>
            <Ack>Failure</Ack>
            <Errors><LongMessage>Category 999 is not valid</LongMessage></Errors>
        </AddFixedPriceItemResponse>"""
        with patch.object(ebay_list, "resolve_condition", return_value="3000"):
            with patch.object(ebay_list, "trading_api_call", return_value=failure_xml):
                with pytest.raises(ebay_list.EbayApiError, match="Category 999 is not valid"):
                    ebay_list.trading_add_fixed_price_item(
                        title="Test",
                        description="Desc",
                        price=50.0,
                        condition="USED_GOOD",
                        image_urls=["https://example.com/img.jpg"],
                        auth_token="tok",
                    )

    def test_auto_suggest_category(self):
        with patch.object(ebay_list, "suggest_category", return_value=[{"id": "179697", "name": "Camera Drones"}]):
            with patch.object(ebay_list, "resolve_condition", return_value="3000"):
                with patch.object(ebay_list, "trading_api_call", return_value=self._mock_success()):
                    ebay_list.trading_add_fixed_price_item(
                        title="DJI Mavic Air 2 Drone",
                        description="Desc",
                        price=500.0,
                        condition="USED_GOOD",
                        image_urls=["https://example.com/img.jpg"],
                        auth_token="tok",
                        category_id="",  # Should auto-suggest
                    )


# ---- EbayApiError ----


class TestEbayApiError:
    def test_is_exception(self):
        assert issubclass(ebay_list.EbayApiError, Exception)

    def test_message(self):
        e = ebay_list.EbayApiError("test error")
        assert str(e) == "test error"

    def test_catchable(self):
        with pytest.raises(ebay_list.EbayApiError):
            raise ebay_list.EbayApiError("boom")
